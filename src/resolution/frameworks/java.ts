/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

// ---------------------------------------------------------------------------
// ANNOTATION-SCANNED BEAN JOIN (v1.1 V3-scanJoin)
// ---------------------------------------------------------------------------
// The resolution-side bridge for `SpringBeansExtractor`'s bean→bean `ref=`
// channel: `ref="userService"` names no `<bean id="userService">` anywhere in
// the XML, but in real Spring apps it overwhelmingly names a Java class
// stereotype-annotated `@Service`/`@Component`/`@Repository`/`@Controller`,
// whose EFFECTIVE bean name is either the annotation's explicit value
// (`@Service("userService")`) or, absent one, the decapitalized simple class
// name (`UserService` → `userService`, Spring's own default-naming rule).
// Real-world validation found ~52% of dangling Spring-beans-XML refs were
// exactly this.
//
// Design choice — resolution-time regex scan over class source, NOT a
// `decorates`-edge lookup: `extractDecoratorsFor` (tree-sitter.ts) already
// emits a `decorates` UnresolvedReference from an annotated class to the
// annotation's bare name (`Service`), which looks like the obvious signal to
// query post-resolution. It isn't usable here: Spring's own `@Service` et al.
// are framework-external (never declared in-repo), so that `decorates` ref
// itself never resolves to anything — like every other unresolved reference,
// it gets DELETED from the unresolved_references table at the end of the
// very same batch that failed to resolve it (see `resolveAndPersistBatched`'s
// "both resolved and unresolved refs are deleted" cleanup), with no ordering
// guarantee relative to when THIS bridge's own ref is processed. Nor does it
// carry the annotation's explicit VALUE argument — `extractDecoratorsFor`
// only records the decorator's plain identifier. A direct regex scan of the
// class's own source (mirroring this file's existing `@Value`/`@RequestMapping`
// extraction, and `springResolver.detect()`'s own `context.readFile` use) is
// therefore both more accurate (captures the value) and unconditionally
// available, matching the task brief's fallback: "have the JAVA extractor
// already record the derived bean name somewhere match-able" — done here at
// resolve time instead of extraction time so it stays a pure resolution-layer
// concern, costs nothing for non-Spring-XML projects (built lazily, only when
// an XML bean ref actually needs it), and needs no new node kind.
//
// Precision gates (per codegraph's retrieval/precision contract):
//  - Scoped to unresolved `references` whose SOURCE is a Spring-beans-XML
//    bean node (`kind: 'variable'`, `language: 'xml'` — SpringBeansExtractor's
//    node shape; see its class doc) — never touches a same-shaped `references`
//    ref from any other language/extractor.
//  - Resolves ONLY when EXACTLY ONE class in the whole project derives that
//    effective bean name (`buildSpringBeanNameIndex` below) — two classes
//    landing on the same name (default OR explicit) is genuine ambiguity in a
//    real Spring app (whichever XML config wins depends on classpath scanning
//    order, which codegraph can't observe), so it's left unresolved rather
//    than guessing.
//  - Stands DOWN entirely (no edge from this join) when an XML-DECLARED bean
//    (`<bean id="…">`/`name="…"`) with the exact ref name exists
//    (`xmlDeclaredBeanNameIndexes` below) — an explicit XML bean definition
//    always outranks a scanned-component guess in Spring semantics, whether
//    one or several XML files declare that id. Strategy 3 name matching
//    handles the declared-bean case (incl. its own ambiguity degrade for
//    profile-split multi-file declarations) once this join stays out of it.
//  - `claimsReference`'s pre-filter opt-in is gated on the SAME source check
//    as `resolve()` (both call `isXmlBeanJoinSourceRef`) — the opt-in escape
//    routes a claimed ref through codegraph's ENTIRE resolution pipeline for
//    that ref (every other framework, import resolution, `matchFuzzy`), not
//    just this resolver's own `resolve()`, so a name-shape-only claim (with
//    no `referenceKind`/`language`/source-node check) would leak unrelated
//    dangling camelCase refs project-wide into strategies that then resolve
//    them wrongly.
//  - Marked like every other framework-synthesized edge here: `resolvedBy:
//    'framework'` via the normal ResolvedRef→Edge path (`createEdges` in
//    resolution/index.ts stamps `metadata.{confidence,resolvedBy}` — the same
//    convention `resolveByNameAndKind`'s Service/Repository/Controller
//    patterns below already use), no bespoke edge-creation path needed.

/** Java/Kotlin stereotype annotations that register a bean with Spring's component scanner. */
const SPRING_STEREOTYPE_ANNOTATIONS = ['Component', 'Service', 'Repository', 'Controller'];

/**
 * Reused across all four stereotypes: `@Stereotype` optionally followed by
 * `("value")` / `(value = "value")`, then zero or more OTHER annotations
 * (any order relative to the stereotype — `@Service @Transactional class X`
 * and `@Transactional @Service class X` both match, since the regex only
 * anchors on the stereotype token and the literal class name, not their
 * relative position) and modifier keywords, then `class <ClassName>`. Built
 * per-class (the class's own simple name is spliced in as a literal) rather
 * than once, so a multi-class file resolves each class's OWN annotation only
 * — never a sibling class's.
 */
function stereotypeAnnotationRegex(className: string): RegExp {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stereotypeAlt = SPRING_STEREOTYPE_ANNOTATIONS.join('|');
  return new RegExp(
    `@(?:${stereotypeAlt})\\b` +
      `(?:\\s*\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["']\\s*\\))?` +
      `\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*` +
      `(?:public\\s+|final\\s+|abstract\\s+|static\\s+|sealed\\s+|non-sealed\\s+|open\\s+|data\\s+)*` +
      `class\\s+${escapedClass}\\b`
  );
}

/** `UserService` → `userService` — Spring's own default bean-naming rule. */
function decapitalize(name: string): string {
  return name.length > 0 ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

/**
 * This class's EFFECTIVE Spring bean name, or `null` when it carries no
 * stereotype annotation at all. `context.readFile` + `stripCommentsForRegex`
 * mirrors `springResolver.extract()`'s own regex approach elsewhere in this
 * file (comments stripped so a `// @Service` in a docstring never fires;
 * string-literal CONTENTS are preserved by `stripCommentsForRegex`'s C-style
 * mode, so the `"userService"` in `@Service("userService")` survives intact).
 */
function derivedBeanName(cls: Node, context: ResolutionContext): string | null {
  const content = context.readFile(cls.filePath);
  if (!content) return null;
  // Kotlin shares Java's comment/string syntax; `stripCommentsForRegex` has
  // no dedicated 'kotlin' mode, and `extract()` below already reuses 'java'
  // for both languages for the same reason.
  const safe = stripCommentsForRegex(content, 'java');
  const match = stereotypeAnnotationRegex(cls.name).exec(safe);
  if (!match) return null;
  const explicitValue = match[1]?.trim();
  return explicitValue ? explicitValue : decapitalize(cls.name);
}

/**
 * derived bean name → candidate class node ids, built ONCE per resolution
 * context (a `WeakMap` keyed by the context object itself — not a module-
 * level `Map` — so a second `CodeGraph` instance in the same process, e.g.
 * back-to-back test suites, never sees a stale/foreign project's index; same
 * pattern as `cics.ts`'s `transidIndexes` and `rust.ts`'s
 * `cargoWorkspaceMapCache`). Lazily built on first use — a project with no
 * Spring-beans-XML dangling refs never triggers a single `readFile` here.
 * Cost is one file read + one regex exec per Java/Kotlin CLASS node,
 * proportional to project size but paid at most once per resolution pass —
 * never per-reference, which is what would risk the O(refs × classes)
 * blow-up the config-key resolution incident (#1180) already burned this
 * codebase on once.
 */
const springBeanNameIndexes = new WeakMap<ResolutionContext, Map<string, string[]>>();

function buildSpringBeanNameIndex(context: ResolutionContext): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const classes = context
    .getNodesByKind('class')
    .filter((n) => n.language === 'java' || n.language === 'kotlin');
  for (const cls of classes) {
    const name = derivedBeanName(cls, context);
    if (!name) continue;
    const existing = index.get(name);
    if (existing) existing.push(cls.id);
    else index.set(name, [cls.id]);
  }
  return index;
}

/**
 * Names of every XML-DECLARED bean (`<bean id="…">`/`name="…"`, plus the
 * namespaced-element equivalents — `SpringBeansExtractor.emitBean`/
 * `emitNamespacedBean`'s `kind: 'variable'`, `language: 'xml'` node shape).
 * Same lazy-build-once-per-context caching as `springBeanNameIndexes` above.
 *
 * Used by the join's ambiguity gate below: Spring semantics say an EXPLICIT
 * `<bean id="userService">` always overrides a scanned `@Service` component
 * with the same effective name (whichever XML config actually wins between
 * several declared beans of that name — e.g. dev/prod profile-split contexts
 * — is left to the generic name-matcher's own multi-candidate handling,
 * which this join must stand down for either way).
 */
const xmlDeclaredBeanNameIndexes = new WeakMap<ResolutionContext, Set<string>>();

function buildXmlDeclaredBeanNameIndex(context: ResolutionContext): Set<string> {
  const names = new Set<string>();
  for (const n of context.getNodesByKind('variable')) {
    if (n.language === 'xml') names.add(n.name);
  }
  return names;
}

/**
 * Does `ref` come from the Spring-beans-XML bean `ref=` channel this join
 * bridges — i.e. is this resolver actually entitled to claim/resolve it?
 * Shared by `claimsReference` (the pre-filter opt-in) and `resolve` (the
 * actual join) so the two can never diverge: a ref this returns `false` for
 * must never reach `matchFuzzy`/import-resolution/other frameworks via this
 * resolver's pre-filter escape, AND must never be joined by `resolve` either.
 * `kind: 'variable'`, `language: 'xml'` per
 * SpringBeansExtractor.emitBean/emitNamespacedBean — a `references` ref from
 * any other xml-language source (MyBatis's extractor also emits
 * `xml`-language `references` refs, but from method/constant-kind nodes) is
 * excluded by the node-kind check, not just the language check.
 */
function isXmlBeanJoinSourceRef(ref: UnresolvedRef, context?: ResolutionContext): boolean {
  if (ref.referenceKind !== 'references' || ref.language !== 'xml') return false;
  const fromNode = context?.getNodeById?.(ref.fromNodeId);
  // `getNodeById`/`context` unavailable (e.g. minimal test doubles) — fall
  // back to trusting `language==='xml'` + `referenceKind==='references'`
  // alone, same as before this was extracted into a shared helper.
  return !fromNode || (fromNode.kind === 'variable' && fromNode.language === 'xml');
}

/**
 * A bare identifier shaped like a decapitalized multi-word class name
 * (`userService`, `dataSourceBean`) — starts lowercase, has at least one
 * LATER uppercase letter (a genuine camelCase word boundary), and no
 * separator character. This is the `claimsReference` opt-in for the join
 * above: the ref's exact name never exists as a declared node (that's WHY
 * it's dangling — the whole point of this bridge), so the resolver's
 * name-existence pre-filter drops it before `resolve()` ever runs, same
 * problem `cics.ts`'s `cics-transid:` prefix and `terraform.ts`'s
 * `module.M:` prefix solve for their own dangling-by-construction refs. This
 * bridge has no such extractor-emitted sentinel to key off (the XML
 * extractor's `ref=` value is deliberately a PLAIN bean name — see
 * `pushRef`'s doc comment — so ordinary bean→bean XML refs keep resolving via
 * the generic exact-name matcher unchanged), so the opt-in is a name-SHAPE
 * heuristic instead. Deliberately narrower than a bare `/^[a-z]\w*$/` shape
 * (which would additionally claim single-word names like `list`/`service` —
 * the common shape of a genuinely-dangling call/typo in ANY language, not
 * just Spring — inflating this escape hatch project-wide): requiring an
 * internal capital cuts that overlap sharply, since a real single-word
 * identifier essentially never LOOKS like this, while a decapitalized
 * multi-word Java class name (the realistic bean-name population validation
 * found) always does.
 *
 * The shape check ALONE is still not a safe opt-in, though: `claimsReference`
 * only receives a bare `name` from the index-level shape regex, but the
 * pre-filter escape it feeds (`resolveOne` in resolution/index.ts) routes a
 * claimed ref through the FULL resolution pipeline for that ref — every
 * OTHER registered framework, import resolution, and Strategy-3 name
 * matching including `matchFuzzy` — not just this resolver's own `resolve()`.
 * A camelCase-shaped name is common far outside Spring XML (external static
 * imports, library calls, ordinary typos in ANY language), so a shape-only
 * claim would opt those into `matchFuzzy` too and manufacture wrong edges
 * project-wide — this is why `claimsReference` also calls
 * `isXmlBeanJoinSourceRef` (the same source check `resolve()` uses) before
 * claiming: only a ref that is ACTUALLY the XML-bean-sourced channel this
 * join bridges gets the escape, so every other camelCase-shaped ref (any
 * language, any kind) is unaffected, same as before this bridge existed.
 * Trade-off, accepted deliberately: an explicit `@Service("all-lowercase")`
 * or `@Service("kebab-case")` value has no internal capital and won't be
 * claimed by this shape check — recall loss on an unusual naming choice, not
 * a correctness bug (mirrors this codebase's existing "accepted recall loss"
 * stance — see `PLACEHOLDER_REF_NO_DEFAULT_RE`'s doc comment in the
 * extractor for the same kind of documented trade-off).
 */
const XML_BEAN_JOIN_NAME_SHAPE_RE = /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/;

export const springResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin', 'yaml', 'properties'],

  claimsReference(name: string, ref?: UnresolvedRef, context?: ResolutionContext): boolean {
    // `@ConfigurationProperties(prefix="app.cache")` emits a reference whose
    // name carries the `:prefix` sentinel — there's no declared symbol with
    // that exact spelling, so the resolver's name-existence pre-filter would
    // drop it. Opt those through. (This sentinel is only ever emitted on a
    // java/kotlin-sourced `references` ref by `extractSpringValueBindings`,
    // so it can't collide with an unrelated xml/other-language ref.)
    if (name.endsWith(':prefix')) return true;
    // See `XML_BEAN_JOIN_NAME_SHAPE_RE`'s doc comment above. The shape check
    // alone is NOT enough to opt a ref in: without `ref`/`context` this
    // resolver cannot tell a genuinely-dangling XML bean `ref=` apart from
    // an unrelated dangling camelCase name in ANY language (an external
    // static-import call, a typo'd method name, …) — and the pre-filter
    // escape below routes a claimed ref through the FULL resolution
    // pipeline (every other framework, imports, `matchFuzzy`), not just this
    // resolver's own `resolve()`. So: no `ref` (a caller not passing it) ⇒
    // don't claim, conservatively — and with `ref`, only claim when it's
    // actually the XML-bean-sourced ref this join is scoped to.
    if (!ref) return false;
    return XML_BEAN_JOIN_NAME_SHAPE_RE.test(name) && isXmlBeanJoinSourceRef(ref, context);
  },

  detect(context: ResolutionContext): boolean {
    // Check for pom.xml with Spring
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true;
    }

    // Check for build.gradle with Spring
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true;
    }

    // Check for Spring annotations in Java files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // ANNOTATION-SCANNED BEAN JOIN (v1.1 V3-scanJoin) — see the module-level
    // doc comment above for the full design rationale. Gated first (cheap
    // field checks) so every OTHER ref pays only this one check: a
    // Spring-beans-XML bean node's `ref=` channel is the ONLY thing that
    // reaches here — see `isXmlBeanJoinSourceRef`'s doc comment.
    if (isXmlBeanJoinSourceRef(ref, context)) {
      // An EXPLICIT XML-declared bean with this exact name/id always
      // outranks a scanned-component guess in real Spring semantics — the
      // ambiguity precision gate below only counts COMPETING @Stereotype
      // classes, so without this check a profile-split `<bean id="userService">`
      // declared in two XML files (a common real layout) lost to the
      // annotated class here at 0.85, even though `<bean id>` is a stronger,
      // explicit signal than a scanned default/annotated name. Stand down
      // and let Strategy 3 name matching resolve to the declared XML bean(s)
      // instead (its own ambiguity handling degrades confidence when several
      // files declare the same id, same as any other multiply-declared name).
      let declaredBeanNames = xmlDeclaredBeanNameIndexes.get(context);
      if (!declaredBeanNames) {
        declaredBeanNames = buildXmlDeclaredBeanNameIndex(context);
        xmlDeclaredBeanNameIndexes.set(context, declaredBeanNames);
      }
      if (!declaredBeanNames.has(ref.referenceName)) {
        let index = springBeanNameIndexes.get(context);
        if (!index) {
          index = buildSpringBeanNameIndex(context);
          springBeanNameIndexes.set(context, index);
        }
        const candidates = index.get(ref.referenceName);
        if (candidates && candidates.length === 1) {
          return { original: ref, targetNodeId: candidates[0]!, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
      // No unique annotated-class candidate (0 or >1 — the precision gate),
      // or an XML-declared bean with this name exists (the priority gate
      // above) — no edge from THIS join, and no other pattern in this
      // resolver applies to an XML-sourced ref either, so stop here rather
      // than falling through to the Java/Kotlin-source patterns below.
      return null;
    }

    // Spring config-key references — `@Value("${key}")` (single leaf) and
    // `@ConfigurationProperties(prefix="X")` (entire subtree, marked with the
    // `:prefix` suffix in extractSpringValueBindings). Lookup goes through
    // Spring's relaxed binding (kebab/camel/snake → canonical lowercase).
    if (ref.referenceName.endsWith(':prefix')) {
      const prefix = ref.referenceName.slice(0, -':prefix'.length);
      const canonPrefix = canonicalConfigKey(prefix);
      // Prefer an exact prefix match (one node = the prefix subtree). Without
      // node-level subtree representation we map to the closest matching key.
      const candidates = context.getNodesByKind('constant').filter(
        (n) => (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName).startsWith(canonPrefix),
      );
      if (candidates.length === 0) return null;
      // Pick the SHORTEST canonical name — it's the closest binding point
      // (`app.cache` over `app.cache.name.user-token` for prefix=`app.cache`).
      const best = candidates.reduce((a, b) =>
        canonicalConfigKey(a.qualifiedName).length <= canonicalConfigKey(b.qualifiedName).length ? a : b,
      );
      return { original: ref, targetNodeId: best.id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.includes('.') && ref.language !== 'java' && ref.language !== 'kotlin') {
      // Spring config dotted key — only when the source language is Java/Kotlin
      // (the bindings come from `@Value`). Skip non-Spring refs that happen to
      // have dots in them.
    }
    // Spring config-key resolution: `@Value("${a.b.c}")` and
    // `@ConfigurationProperties`. Gate on the `references` kind — those bindings
    // are emitted as `references` by extractSpringValueBindings, whereas the far
    // more numerous method-call refs (`list.add()`, `builder.build()`, every
    // `receiver.method()`) are `calls`. A config key is NEVER a `calls` ref, so
    // this loses no resolution. Without the gate, every dotted `calls` ref fell
    // into the uncached getNodesByKind('constant') scan below — an
    // O(dotted-calls × constant-nodes) cost that dominated resolution and made a
    // full index take ~1h on large Java/Kotlin (Spring) monorepos (#1180). The
    // old `split('.').length >= 2` heuristic couldn't separate keys from calls;
    // the kind check does it exactly.
    if (
      ref.referenceKind === 'references' &&
      (ref.language === 'java' || ref.language === 'kotlin') &&
      ref.referenceName.includes('.') &&
      !ref.referenceName.includes('::')
    ) {
      const canonRef = canonicalConfigKey(ref.referenceName);
      const candidates = context.getNodesByKind('constant').filter(
        (n) => n.kind === 'constant'
          && (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName) === canonRef,
      );
      if (candidates.length === 1) {
        return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      if (candidates.length > 1) {
        // Multiple profile-specific files (application-dev.yml +
        // application-prod.yml) can define the same key. Prefer the one with
        // the shortest profile suffix (the base `application.yml` wins over
        // profile variants when both exist), then by alphabetical path so the
        // pick is deterministic across reindexes.
        const score = (n: Node) => {
          const base = n.filePath.split('/').pop() ?? '';
          const isBase = /^(application|bootstrap)\.(yml|yaml|properties)$/i.test(base);
          return (isBase ? 0 : 1) * 1000 + base.length;
        };
        const best = candidates.reduce((a, b) => (score(a) <= score(b) ? a : b));
        return { original: ref, targetNodeId: best.id, confidence: 0.75, resolvedBy: 'framework' };
      }
    }

    // Pattern 1: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Entity/Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, ENTITY_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 5: Component references
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, COMPONENT_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    // Spring config files (application.yml / application.properties /
    // bootstrap.yml + per-profile variants) are extracted on the framework
    // path, not in the language extractor, so the keys become first-class
    // nodes a `@Value("${k}")` reference can resolve to.
    if (isSpringConfigFile(filePath)) {
      return extractSpringConfig(filePath, content);
    }
    // Spring Boot is used from both Java and Kotlin (identical @GetMapping etc.
    // annotations); the difference is method syntax — Kotlin `fun name(...)` vs
    // Java `public X name(...)` — handled in the method regex below.
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    // Class-level @RequestMapping prefix (an @RequestMapping whose tail leads to a
    // `class`). Joined onto each method's path — and, crucially, NOT treated as a
    // route itself (the old regex did, creating one bogus class route and missing
    // every BARE method mapping like `@PostMapping` with the path on the class).
    let classPrefix = '';
    const cls = /@RequestMapping\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.exec(safe);
    if (cls) classPrefix = parseMappingPath(cls[1]!);

    const VERB: Record<string, string> = {
      GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
    };
    // Verb-specific method mappings — always method-level, BARE or with a path.
    const mappingRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;
    while ((match = mappingRegex.exec(safe)) !== null) {
      const method = VERB[match[1]!]!;
      const sub = parseMappingPath((match[2] || '').replace(/^\(|\)$/g, ''));
      const routePath = joinPath(classPrefix, sub);
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      // Method it decorates: first declared method after (skip stacked annotations;
      // Java puts the return type before the name). Bounded so we don't grab a far one.
      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // Method-level @RequestMapping (older style: `@RequestMapping(value="/x",
    // method=RequestMethod.GET)` on a method). The class-level @RequestMapping is
    // the prefix (handled above) — skip it here so it isn't double-counted.
    const reqRe = /@RequestMapping\b\s*(\([^)]*\))?/g;
    while ((match = reqRe.exec(safe)) !== null) {
      const args = (match[1] || '').replace(/^\(|\)$/g, '');
      const after = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.test(after)) continue; // class-level prefix
      const methodMatch = after.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (!methodMatch) continue;
      const verbM = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/);
      const method = verbM ? verbM[1]!.toUpperCase() : 'ANY';
      const routePath = joinPath(classPrefix, parseMappingPath(args));
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: lang, updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: (methodMatch[1] ?? methodMatch[2])!,
        referenceKind: 'references',
        line, column: 0, filePath, language: lang,
      });
    }

    // @Value("${key}") and @ConfigurationProperties(prefix="...") — bind
    // Spring config-key references in Java/Kotlin source. The reference target
    // is the corresponding YAML/properties leaf-key node emitted by
    // extractSpringConfig; springResolver.resolve looks it up with relaxed
    // binding (kebab/camel/snake collapse).
    extractSpringValueBindings(filePath, safe, lang, now, nodes, references);

    return { nodes, references };
  },
};

/** Spring config file patterns: application(-profile)?.{yml,yaml,properties} +
 * bootstrap variants. Matches the basename, not the path, so a project that
 * vendors `application.yml` under `src/main/resources` and one under `src/test/
 * resources` are both picked up. */
function isSpringConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  return /^(application|bootstrap)(-[\w.-]+)?\.(yml|yaml|properties)$/i.test(base);
}

/**
 * Parse a Spring config file (YAML or .properties) and emit one `constant`
 * node per LEAF key, with `qualifiedName` = the dotted path. Leaf keys are
 * what `@Value("${k}")` references hit; intermediate keys aren't bound by
 * Spring's `@Value` (a `@ConfigurationProperties` class binds a SUBTREE, and
 * those references are resolved at lookup time by prefix-suffix matching).
 */
function extractSpringConfig(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const isProperties = /\.properties$/i.test(filePath);
  const lang = isProperties ? 'properties' : 'yaml';
  const now = Date.now();

  const emitLeaf = (dottedKey: string, line: number, valueText: string) => {
    if (!dottedKey) return;
    nodes.push({
      id: `spring-config:${filePath}:${line}:${dottedKey}`,
      kind: 'constant',
      name: dottedKey.split('.').pop() ?? dottedKey,
      qualifiedName: dottedKey,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: valueText.length,
      language: lang,
      signature: dottedKey,
      // SECURITY (#383): store the KEY only, never the value. Config files
      // routinely hold secrets (DB passwords, API keys, JDBC URLs with embedded
      // credentials), and surfacing the value here pushes it into agent context
      // unbidden (it lands in codegraph_node/explore output via the docstring).
      // The key is all `@Value`/`@ConfigurationProperties` resolution needs; an
      // agent that genuinely needs a value can read the file directly.
      updatedAt: now,
    });
  };

  if (isProperties) {
    // Properties format: `k1.k2.k3 = value` (or `:` separator, or no value).
    // Lines starting with `#`/`!` are comments. Backslash continuations are
    // valid but rare; we don't try to join them (a continued value is still
    // a value of the same key).
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const sep = (() => {
        for (let j = 0; j < raw.length; j++) {
          const ch = raw[j];
          if (ch === '=' || ch === ':') return j;
          if (ch === '\\' && raw[j + 1]) { j++; continue; }
        }
        return -1;
      })();
      if (sep < 0) continue;
      const key = raw.slice(0, sep).trim();
      const val = raw.slice(sep + 1).trim();
      emitLeaf(key, i + 1, val);
    }
    return { nodes, references: [] };
  }

  // YAML: indent-based. We track a stack of (indent, key) so the dotted path
  // is built by joining ancestor keys with `.`. A leaf is a line with a value
  // on the same line (after `:`). List items, flow-style scalars, and `---`
  // separators are ignored — they don't bind to `@Value` anyway.
  const stack: Array<{ indent: number; key: string }> = [];
  const yamlLines = content.split(/\r?\n/);
  for (let i = 0; i < yamlLines.length; i++) {
    const raw = yamlLines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('- ')) continue;
    const indent = raw.length - raw.replace(/^[\t ]+/, '').length;
    const colonIdx = (() => {
      let inStr: string | null = null;
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j];
        if (inStr) { if (ch === inStr && raw[j - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === ':') return j;
      }
      return -1;
    })();
    if (colonIdx < 0) continue;
    const key = raw.slice(indent, colonIdx).trim();
    if (!key) continue;
    const after = raw.slice(colonIdx + 1).trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const dotted = [...stack.map((s) => s.key), key].join('.');
    if (after === '' || after.startsWith('#')) {
      stack.push({ indent, key });
    } else {
      // A leaf with an inline value (or a flow-mapping like `{ a: 1 }` — we
      // emit it as a leaf, not as a subtree; precision is fine for `@Value`).
      const valStripped = after.replace(/^["']|["']$/g, '');
      emitLeaf(dotted, i + 1, valStripped);
    }
  }
  return { nodes, references: [] };
}

/** Append `@Value("${k}")` and `@ConfigurationProperties(prefix=...)`
 * references discovered in `safe` (comments stripped) into the caller's
 * `nodes`/`references` arrays. */
function extractSpringValueBindings(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  now: number,
  nodes: Node[],
  references: UnresolvedRef[],
): void {
  const valueRe = /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = valueRe.exec(safe)) !== null) {
    const key = m[1]!.trim();
    if (!key) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-value:${filePath}:${line}:${key}`,
      kind: 'constant',
      name: key,
      qualifiedName: `${filePath}::@Value:${key}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@Value("${key}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      referenceName: key,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }

  const cpRe = /@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?["']([^"']+)["']/g;
  while ((m = cpRe.exec(safe)) !== null) {
    const prefix = m[1]!.trim();
    if (!prefix) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-cp:${filePath}:${line}:${prefix}`,
      kind: 'constant',
      name: prefix,
      qualifiedName: `${filePath}::@ConfigurationProperties:${prefix}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@ConfigurationProperties("${prefix}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      // Mark the reference with a `:prefix` suffix so springResolver.resolve
      // knows to expand it into the SUBTREE rather than a single key.
      referenceName: `${prefix}:prefix`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }
}

/** Spring's relaxed binding (`cache-list` ↔ `cacheList` ↔ `cache_list` ↔
 * `CACHE_LIST`) collapses on lowercase + dash/underscore removal. We compare
 * candidate keys to a reference in this canonical form. */
function canonicalConfigKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

// Directory patterns
const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/** Path string from a mapping's args (`"/x"`, `value = "/x"`, `path = "/x"`); '' if bare. */
function parseMappingPath(args: string): string {
  const m = args.match(/["']([^"']*)["']/);
  return m ? m[1]! : '';
}

/** Join a class-level prefix and a method sub-path into one normalized `/path`. */
function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
