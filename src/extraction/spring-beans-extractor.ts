import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * SpringBeansExtractor — parses Spring `<beans>` XML configuration files.
 *
 * Modeled on the sibling `MyBatisExtractor` (regex-based, comment-stripping
 * pre-pass, either-quote attributes, byte-offset node ids, file node + symbol
 * nodes + unresolvedReferences) but for a fundamentally nested document shape:
 * a MyBatis mapper's `<select>`/`<insert>` statements never nest inside one
 * another, so a single non-recursive tag-pair regex per statement is enough.
 * Spring bean XML nests arbitrarily (`<bean><property><list><ref/></list>
 * </property></bean>`, inner anonymous beans inside a property, `<beans
 * profile="…">` wrapping another batch of beans), so this extractor instead
 * builds a small lenient tag tree (see `parseTree`) and walks it recursively.
 *
 * v1 scope, per the beans-xml parser spec's "codegraph 적용 매핑" section
 * (repos/beans-xml/docs/specs/spec-beans-xml.md). Implemented: bean nodes
 * (recursively, incl. nested-profile and inner/collection beans), id-bearing
 * NamespacedElement registrants (`jee:jndi-lookup`, `util:*`), the bean→class
 * `instantiates` edge, and these bean→bean `references` channels:
 * property/constructor-arg `ref=`, `<ref>`/`<idref>` anywhere in a
 * collection or inner bean, `parent=`/`depends-on=`/`factory-bean=`, p:/c:
 * namespace `-ref` attributes, and lookup-method/replaced-method injection.
 * Deliberately EXCLUDED from v1 (not "full" per the spec's mapping): SpEL
 * `#{bean}` refs; ref-harvesting the contents of other NamespacedElements
 * (aop/tx/task/jee beyond the id registration itself); and two of the
 * spec's three blind-spot promotions — ⑴ `*BeanName`-suffixed by-name refs,
 * ⑵ mapperLocations/configLocation file-edge promotion (the future
 * Spring↔MyBatis bridge). Blind spot ⑶ (jobClass/targetClass by-value FQN
 * promotion) IS implemented as of v1.1 — see `isClassLikePropertyName` /
 * `pushClassPromotion` below.
 */

// ---------------------------------------------------------------------------
// Shared low-level helpers (comment/CDATA stripping, tag scanning)
// ---------------------------------------------------------------------------

/**
 * Blank out XML comments AND CDATA sections before any tag scanning, so a
 * commented-out `<bean>` and a `<value><![CDATA[...]]></value>` whose text
 * happens to contain `<`/`>`-shaped sequences never get mistaken for real
 * tags by the regex tokenizer below. Length-preserving (bytes become spaces,
 * newlines survive) so offsets/line numbers computed afterward still map to
 * the original source — same technique as `MyBatisExtractor.stripXmlComments`.
 * Unlike MyBatis, we never need element TEXT content (only tag/attribute
 * structure), so — unlike the sibling — CDATA content is blanked here too,
 * not preserved: MyBatis needs the raw SQL body for its docstring preview,
 * we don't need bean XML text content for anything.
 */
function stripXmlNoise(source: string): string {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end >= 0 ? end + 3 : n;
      for (let j = i; j < stop; j++) if (source.charCodeAt(j) !== 10) out[j] = ' ';
      i = stop;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      const stop = end >= 0 ? end + 3 : n;
      for (let j = i; j < stop; j++) if (source.charCodeAt(j) !== 10) out[j] = ' ';
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Strip a namespace prefix (`beans:beans` → `beans`) for tag matching that must ignore it. */
function localName(tag: string): string {
  const colon = tag.indexOf(':');
  return colon >= 0 ? tag.slice(colon + 1) : tag;
}

/**
 * Cheap, comment-aware root-tag sniff used by the tree-sitter router to
 * decide MyBatis vs Spring beans for a `.xml` file, without paying for a
 * full tree parse. XML processing instructions (`<?xml …?>`) and DOCTYPE
 * (`<!DOCTYPE …>`) never match the tag-name character class (`?`/`!` aren't
 * `[A-Za-z_]`), so the first match this regex finds is always the real root
 * element — no separate prolog-skipping logic needed. Matched by LOCAL name
 * (namespace prefix stripped) so a prefixed root — `<beans:beans>`, the
 * standard shape for a Spring Security config whose default xmlns is the
 * security schema — still routes here instead of falling through to MyBatis.
 */
export function isSpringBeansXml(source: string): boolean {
  const stripped = stripXmlNoise(source);
  const m = /<([A-Za-z_][\w:.-]*)/.exec(stripped);
  return !!m && localName(m[1]!) === 'beans';
}

/**
 * Decode the standard XML predefined entities (`&amp; &lt; &gt; &quot;
 * &apos;`) plus numeric character references (`&#NN;` / `&#xHH;`) in an
 * attribute value. Well-formed XML MUST escape a literal `&` as `&amp;` —
 * the factory-dereference marker on a ref is therefore written
 * `ref="&amp;factoryBean"`, not a raw `&`, so without this decode step the
 * value stays `&amp;factoryBean` and `pushRef`'s leading-`&` strip produces
 * garbage (`amp;factoryBean`). Single left-to-right pass over the ORIGINAL
 * text (not iterative re-scanning), so `&amp;lt;` correctly decodes to the
 * literal text `&lt;`, never double-decodes to `<`.
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#\d+);/g, (whole, ent: string) => {
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (ent.startsWith('#x')) return decodeNumericEntity(parseInt(ent.slice(2), 16), whole);
        if (ent.startsWith('#')) return decodeNumericEntity(parseInt(ent.slice(1), 10), whole);
        return whole;
    }
  });
}

/**
 * `String.fromCodePoint` throws a RangeError for anything outside the valid
 * Unicode range (`0`–`0x10FFFF`) or a non-finite/NaN input (a malformed
 * `&#…;`/`&#x…;` reference). Left unguarded, that throw escapes all the way
 * up through `decodeXmlEntities` → `parseAttrs` → the tree parser into
 * `extract()`'s catch, which degrades the ENTIRE file to file-node-only —
 * one bad numeric entity anywhere in a large file would otherwise wipe out
 * every real bean in it. So: validate first, and try/catch as a belt-and-
 * suspenders backstop; either way an invalid entity just falls back to its
 * raw source text (`whole`, e.g. `&#x110000;`) and extraction continues.
 */
function decodeNumericEntity(codePoint: number, whole: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return whole;
  }
}

/** A lenient, generic XML element — tag name, attributes, and child elements. */
interface XmlEl {
  tag: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Byte offset of the `<` that opens this element (used for node ids/lines). */
  start: number;
  /** Byte offset just past the closing `>` (real or implicit — see `LenientXmlTreeParser.parse`). */
  end: number;
}

/**
 * Parse `name="value"` / `name='value'` pairs out of a tag's attribute
 * region. Either quote style is accepted (mirrors MyBatis). A value is
 * excluded from containing EITHER quote char (`[^"']*`) — the same tradeoff
 * MyBatis's attribute regex makes: bean ids/class names/ref targets never
 * contain a quote character in practice, so this is safe, and it keeps the
 * regex simple and non-backtracking-prone. Empty values (`ref=""`) parse to
 * `''`, which every caller below treats as absent via a truthy check.
 */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])([^"']*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[3]!);
  }
  return attrs;
}

/** Last dotted/`.`-separated segment of a Java-ish class name. */
function simpleClassName(fqn: string): string {
  const trimmed = fqn.trim();
  const dot = trimmed.lastIndexOf('.');
  return dot >= 0 ? trimmed.slice(dot + 1) : trimmed;
}

/**
 * Convert a Java FQN as written in `class="…"` (all-dotted, e.g.
 * `com.example.FooServiceImpl`) into the qualifiedName shape codegraph's
 * Java extractor actually produces for that same class: package segments
 * stay dotted, but the LAST separator (package boundary → class name)
 * becomes `::` (see `TreeSitterExtractor.buildQualifiedName` /
 * `languages/java.ts#extractPackage` — a Java class's qualifiedName is
 * `<dotted.package>::<ClassName>`, not the fully-dotted FQN). Without this
 * conversion the `instantiates` reference would never exact-match via the
 * resolver's qualified-name strategy (`matchByQualifiedName`), because
 * `getNodesByQualifiedName` does a literal string lookup with no dot/`::`
 * normalization. A bare class name with no package (no `.`) is returned
 * unchanged — it still has a shot at resolving via exact simple-name match.
 */
function javaFqnToQualifiedName(fqn: string): string {
  const trimmed = fqn.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot < 0 ? trimmed : `${trimmed.slice(0, dot)}::${trimmed.slice(dot + 1)}`;
  // A static nested class is written `Outer$Inner` in a `class=` attribute
  // (binary-name form) but the Java extractor's qualifiedName nests it as
  // `Outer::Inner` (same `::` separator as the package/class boundary
  // above) — map every `$` the same way so `com.example.Outer$Inner`
  // resolves to `com.example::Outer::Inner`.
  return base.replace(/\$/g, '::');
}

/**
 * Blind-spot ⑶ from the beans-xml spec: a `<property>`/`<constructor-arg>`
 * (or p:/c: namespace literal) whose NAME conventionally holds a
 * fully-qualified Java class name as its VALUE — `jobClass`, `targetClass`,
 * `driverClassName`, … the classic Quartz/JDBC-by-string-configuration
 * shape that otherwise leaves the owning bean with zero Java linkage. The
 * boundary is the camelCase transition into the suffix, not a plain
 * case-insensitive "ends with class": `superclass` (lowercase throughout)
 * must NOT match — Java identifiers are case-sensitive and nobody writes a
 * property meaning "this value is a class name" without capitalizing the
 * `C`. Concretely: the char immediately before the suffix's `C` must be
 * lowercase or a digit (a real camelCase boundary), so a bare `"Class"`/
 * `"ClassName"` property name (no prefix to be a boundary against) does
 * NOT match either — same as the literal `class=` attribute, which
 * `emitBean`/`emitNamespacedBean` already handle via their own dedicated
 * channel, not this one.
 */
function isClassLikePropertyName(name: string): boolean {
  let prefixLen: number;
  if (name.endsWith('ClassName')) prefixLen = name.length - 'ClassName'.length;
  else if (name.endsWith('Class')) prefixLen = name.length - 'Class'.length;
  else return false;
  if (prefixLen <= 0) return false;
  return /[a-z0-9]/.test(name[prefixLen - 1]!);
}

/**
 * Is this value shaped like a Java FQN (`com.example.job.SyncJob`, or
 * `com.example.Outer$Inner` for a static nested class)? At least two
 * dotted segments, every segment a valid Java identifier (letters/digits/
 * `_`/`$`, not starting with a digit) — which incidentally also rejects
 * `${placeholder}` values (Spring property-placeholder syntax: the `{`
 * right after `$` is not a legal identifier character, so the whole value
 * fails to match) and anything containing whitespace, without needing a
 * separate check for either. A single-segment value (no dot — e.g. a bare
 * simple class name, or an ordinary non-FQN string) is deliberately
 * excluded: promoting on a wrong-shaped value would fabricate a
 * java-linkage edge nothing in the XML actually asserts.
 */
function isFqnShapedValue(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value);
}

/**
 * Namespace prefixes whose id-bearing elements register a bean-like target
 * (so `ref="dataSource"` pointing at a `<jee:jndi-lookup id="dataSource">`
 * or `<util:list id="triggers">` doesn't dangle — the real eGovFrame JNDI
 * datasource pattern the spec calls out). Other namespaced elements
 * (aop:*, tx:*, context:component-scan, …) are deliberately NOT registrants
 * — out of scope for v1 (see class doc).
 */
const REGISTRANT_NS_PREFIXES = new Set(['util', 'jee']);

/**
 * Lenient tag tokenizer + tree builder. Not a real XML parser: it scans for
 * `<name …>` / `</name>` / `<name …/>` tokens with a single regex and
 * maintains an open-element stack, tolerating the real-world mess MyBatis's
 * own regex scanner tolerates (either quote style, whitespace before the
 * closing `>` of an end tag) plus the recursive-nesting leniency Spring bean
 * XML specifically needs:
 *  - a stray/mismatched closing tag is ignored rather than throwing;
 *  - a closing tag that doesn't match the top of the stack walks UP the
 *    stack to find the nearest matching open element and implicitly closes
 *    everything above it at that point (handles hand-edited/malformed XML
 *    without crashing);
 *  - truncated input (no closing tags at all) auto-closes every element
 *    still on the stack at end-of-source instead of throwing.
 * Multiple top-level elements after the real root are dropped silently (a
 * well-formed document only ever has one root).
 */
class LenientXmlTreeParser {
  // The tag body is a repetition of "any char that isn't >, ", or '" OR a
  // whole quoted string (either quote style) — so a `>` legally embedded in
  // an attribute value (SpEL `p:expr="#{x > 3}"`, any p:/c: literal) stays
  // inside its quoted alternative instead of ending the tag early. A naive
  // `[^>]*` (the prior regex) has no quote-awareness and truncates the tag
  // at that `>`, corrupting containment for every element after it.
  private static readonly TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

  static parse(source: string): XmlEl | null {
    const stack: XmlEl[] = [];
    let root: XmlEl | null = null;
    const attach = (el: XmlEl): void => {
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push(el);
      } else if (!root) {
        root = el;
      }
      // else: extra top-level element after the root already closed — drop.
    };

    const re = new RegExp(LenientXmlTreeParser.TAG_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const isClose = m[1] === '/';
      const tagName = m[2]!;
      let rest = m[3] ?? '';
      const tagStart = m.index;
      const tagEnd = m.index + m[0].length;

      if (isClose) {
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.tag === tagName) {
            idx = i;
            break;
          }
        }
        if (idx === -1) continue; // stray close tag — ignore, never throw
        while (stack.length > idx) {
          const el = stack.pop()!;
          // The matched element (stack.length === idx right after its own
          // pop) gets the real close offset; anything popped above it was
          // implicitly closed here, so it ends at this tag's START.
          el.end = stack.length === idx ? tagEnd : tagStart;
          attach(el);
        }
        continue;
      }

      const selfClose = /\/\s*$/.test(rest);
      if (selfClose) rest = rest.replace(/\/\s*$/, '');
      const el: XmlEl = { tag: tagName, attrs: parseAttrs(rest), children: [], start: tagStart, end: tagEnd };
      if (selfClose) {
        attach(el);
      } else {
        stack.push(el);
      }
    }

    // Truncated input: auto-close whatever is still open at end-of-source.
    while (stack.length > 0) {
      const el = stack.pop()!;
      el.end = source.length;
      attach(el);
    }

    return root;
  }
}

export class SpringBeansExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];
  private fileNodeId = '';
  /** Effective p:/c: namespace prefixes — from a declared `xmlns:X="…schema/p|c"`, else the conventional `p`/`c`. */
  private pPrefix = 'p';
  private cPrefix = 'c';

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = stripXmlNoise(source);
    this.computeLineStarts();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const fileNode = this.createFileNode();
    this.fileNodeId = fileNode.id;

    try {
      const root = LenientXmlTreeParser.parse(this.source);
      // Defensive re-check: the router already sniffed `<beans>` before
      // constructing this extractor, but never trust it twice — malformed
      // input (or a routing edge case) degrades to file-node-only, never a
      // throw, per the leniency contract shared with MyBatis.
      if (root && localName(root.tag) === 'beans') {
        this.pPrefix = this.detectNsPrefix(root.attrs, 'http://www.springframework.org/schema/p', 'p');
        this.cPrefix = this.detectNsPrefix(root.attrs, 'http://www.springframework.org/schema/c', 'c');
        this.walk(root, null, this.fileNodeId);
      }
    } catch (error) {
      this.errors.push({
        message: `Spring beans extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'xml',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private detectNsPrefix(rootAttrs: Record<string, string>, uri: string, fallback: string): string {
    for (const [k, v] of Object.entries(rootAttrs)) {
      if (v === uri && k.startsWith('xmlns:')) return k.slice('xmlns:'.length);
    }
    return fallback;
  }

  /**
   * Recursive walk over the bean tree. `ownerNodeId` is the nearest
   * enclosing bean/NamespacedElement node — the `fromNodeId` for any
   * reference found at this depth (property ref, `<ref>`, collection entry,
   * …). `containerNodeId` is who a newly-emitted node's `contains` edge
   * comes from (the file for top-level beans, the enclosing bean for inner
   * ones) — deliberately tracked separately from `ownerNodeId` because a
   * nested `<beans profile="…">` block resets the reference scope (no bean
   * is "current" inside it until we enter one) without changing who
   * structurally contains its beans (still the file).
   */
  private walk(el: XmlEl, ownerNodeId: string | null, containerNodeId: string): void {
    for (const child of el.children) {
      const tag = child.tag;
      const colon = tag.indexOf(':');
      const localTag = colon >= 0 ? tag.slice(colon + 1) : tag;
      const nsPrefix = colon >= 0 ? tag.slice(0, colon) : '';

      if (localTag === 'beans') {
        // Nested `<beans profile="dev">` block: a fresh top-level bean scope
        // (profile semantics themselves are out of scope — see class doc),
        // still structurally contained by the file. Matched by local name
        // (like `bean` itself) so a prefixed document (`<beans:beans>`)
        // still nests correctly.
        this.walk(child, null, containerNodeId);
        continue;
      }

      if (localTag === 'bean') {
        const beanId = this.emitBean(child, containerNodeId);
        const refFrom = beanId ?? ownerNodeId;
        if (refFrom) this.emitBeanAttrRefs(child, refFrom);
        this.walk(child, beanId ?? ownerNodeId, beanId ?? containerNodeId);
        continue;
      }

      if (nsPrefix && REGISTRANT_NS_PREFIXES.has(nsPrefix) && child.attrs.id) {
        // Contents of a NamespacedElement (e.g. `<util:list>` items) are a
        // known blind spot for v1 (spec: "util 내용물 <ref> 원소 v0.1 미수집") —
        // deliberately not recursed into for refs, only the id-bearing
        // registration itself is emitted.
        this.emitNamespacedBean(child);
        continue;
      }

      if (localTag === 'alias') {
        this.emitAlias(child);
        continue;
      }

      if (localTag === 'import') {
        this.emitImport(child);
        continue;
      }

      if (localTag === 'ref' || localTag === 'idref') {
        // Both `<ref bean=|local=>` and `<idref bean=|local=>` name their
        // target the same way (`bean` takes priority over the older `local`
        // form); `<idref>` differs at runtime (resolves to the bean NAME,
        // not the instance) but that distinction doesn't matter for a
        // reference edge.
        if (ownerNodeId) {
          const target = child.attrs.bean || child.attrs.local;
          this.pushRef(ownerNodeId, target, this.getLineNumber(child.start));
        }
        continue;
      }

      if (localTag === 'entry') {
        if (ownerNodeId) {
          const line = this.getLineNumber(child.start);
          this.pushRef(ownerNodeId, child.attrs['key-ref'], line);
          this.pushRef(ownerNodeId, child.attrs['value-ref'], line);
        }
        // An <entry> value can itself be an inline <bean>/<ref>/<list>/…
        this.walk(child, ownerNodeId, containerNodeId);
        continue;
      }

      if (localTag === 'lookup-method') {
        if (ownerNodeId) this.pushRef(ownerNodeId, child.attrs.bean, this.getLineNumber(child.start));
        continue;
      }

      if (localTag === 'replaced-method') {
        if (ownerNodeId) this.pushRef(ownerNodeId, child.attrs.replacer, this.getLineNumber(child.start));
        continue;
      }

      if (localTag === 'property' || localTag === 'constructor-arg') {
        if (ownerNodeId) {
          const line = this.getLineNumber(child.start);
          this.pushRef(ownerNodeId, child.attrs.ref, line);
          // By-value class promotion (blind spot ⑶): name="jobClass"
          // value="com.example.job.SyncJob" (attribute form) or a <value>
          // child (element form) — see `isClassLikePropertyName`.
          this.pushClassPromotion(ownerNodeId, child.attrs.name, this.getPropertyValue(child), line);
        }
        // The inline value can be a nested <bean>, <ref>, <list>, <map>, …
        this.walk(child, ownerNodeId, containerNodeId);
        continue;
      }

      // Collections (list/set/array/map/props), <value>, <null/>, <prop>,
      // and any unrecognized wrapper: no node/attribute of interest at this
      // level, but keep descending — a Quartz-style `<list><ref/></list>`
      // needs the ref inside it found regardless of how deep it's nested.
      this.walk(child, ownerNodeId, containerNodeId);
    }
  }

  /**
   * Emit a node for `<bean>`. NodeKind is `'variable'`, not `'component'`:
   * a Spring bean declaration is closest in shape to a named binding whose
   * value is a class instantiation (`FooService fooService = new
   * FooServiceImpl();`), which is exactly what `variable` already models
   * elsewhere (Terraform's named `variable` blocks, Liquid's `{% assign %}`)
   * — a declared, referenceable name bound to a value. `'component'` is
   * reserved across the codebase for UI/rendering-tree nodes (React/Vue/
   * Svelte/Astro components) with their own dedicated synthesizers
   * (`callback-synthesizer.ts`'s jsx-render/vue-handler dispatch explicitly
   * scans `kind === 'component'` per file) — reusing it here would risk a
   * Spring bean silently entering that unrelated machinery.
   *
   * qualifiedName = the effective bean name, unscoped by file path. Unlike
   * MyBatis's `<namespace>::<id>` (namespace = the mapper's own Java FQN,
   * so a per-file qualifier is natural), a Spring bean id has no XML-level
   * namespace of its own — it's resolved by plain id within one
   * ApplicationContext assembled from potentially many XML files, i.e. bean
   * ids are "global-ish" across the files that get loaded together. Scoping
   * qualifiedName by file would make `ref="dataSource"` unresolvable
   * whenever the bean and its reference live in different files (the common
   * case), so qualifiedName is deliberately just the bean name — same shape
   * as `name`, resolved via the generic resolver's exact-name matching.
   *
   * Returns null (no node emitted) when the bean has neither an id/name nor
   * a class NOR a parent/factory-bean — nothing to name it by and nothing to
   * link it to, so a node here would be exactly the "valueless leaf" the
   * spec forbids. A `parent=`/`factory-bean=`-only anonymous bean (legal:
   * class is inherited from the parent, or supplied entirely by the factory
   * — e.g. a side-effecting `MethodInvokingFactoryBean`) DOES carry a link
   * (the parent/factory-bean reference itself), so it still gets an anon
   * node to hang that reference off of.
   */
  private emitBean(el: XmlEl, containerNodeId: string): string | null {
    const id = el.attrs.id?.trim();
    const nameAttr = el.attrs.name?.trim();
    // Deduped via Set (insertion order preserved) — a repeated token
    // (`name="b,b"`) would otherwise walk the `nameTokens` loop below twice
    // for the same name, emitting two node objects that hash to the exact
    // same id (`generateNodeId` is a pure function of file/kind/name/line),
    // i.e. a literal duplicate row rather than a harmless no-op.
    const nameTokens = nameAttr ? [...new Set(nameAttr.split(/[,;\s]+/).filter(Boolean))] : [];
    const firstName = nameTokens[0];
    const cls = el.attrs.class?.trim();
    const hasLinkOnly = !!(el.attrs.parent?.trim() || el.attrs['factory-bean']?.trim());
    const effectiveName = id || firstName;
    if (!effectiveName && !cls && !hasLinkOnly) return null;

    const line = this.getLineNumber(el.start);
    const name = effectiveName || (cls ? `<${simpleClassName(cls)}$anon@${line}>` : `<bean$anon@${line}>`);
    const qualifiedName = name;
    // Byte offset (not just line) folded into the id hash so two beans that
    // land on the same line (inline inner beans, several one-line `<bean/>`
    // list items) never collide — same technique MyBatis uses for its own
    // same-line duplicate-id case.
    const nodeId = generateNodeId(this.filePath, 'variable', qualifiedName, el.start);

    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'xml',
      signature: cls ? `class="${cls}"` : undefined,
      startLine: line,
      endLine: this.getLineNumber(el.end),
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: containerNodeId, target: nodeId, kind: 'contains' });

    if (cls) {
      this.unresolvedReferences.push({
        fromNodeId: nodeId,
        referenceName: javaFqnToQualifiedName(cls),
        referenceKind: 'instantiates',
        line,
        column: 0,
      });
    }

    // Spec name-index contract: a ref resolves against id ∪ names ∪ alias.
    // `name=` can carry MULTIPLE space/comma/semicolon-separated tokens, and
    // every token beyond the one already used as this node's own `name`
    // (either because `id` won, or because it WAS the first name token) is a
    // second registered name for the same bean — a `ref=` to any of them
    // must resolve here too. Same two-hop synthetic-node trick `emitAlias`
    // already uses for `<alias>`: a tiny node per extra name with a
    // `references` edge back to the primary name.
    for (const token of nameTokens) {
      if (token === effectiveName) continue;
      this.emitSecondaryName(token, name, el.start, line);
    }

    return nodeId;
  }

  /** See the `nameTokens` loop in `emitBean` — one extra registered name for a bean. */
  private emitSecondaryName(token: string, primaryName: string, startOffset: number, line: number): void {
    const nodeId = generateNodeId(this.filePath, 'variable', token, startOffset);
    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name: token,
      qualifiedName: token,
      filePath: this.filePath,
      language: 'xml',
      signature: `secondary name for "${primaryName}"`,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: this.fileNodeId, target: nodeId, kind: 'contains' });
    this.unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: primaryName,
      referenceKind: 'references',
      line,
      column: 0,
    });
  }

  /**
   * Emit a node for an id-bearing NamespacedElement that registers a bean
   * (`<jee:jndi-lookup id="dataSource">`, `<util:list id="triggers">`, …) —
   * without this, `ref="dataSource"` elsewhere dangles. Same node shape as
   * `emitBean` (kind `variable`, qualifiedName = id) so it resolves through
   * the exact same reference channel as a real `<bean>`.
   */
  private emitNamespacedBean(el: XmlEl): string | null {
    const id = el.attrs.id?.trim();
    if (!id) return null;
    const line = this.getLineNumber(el.start);
    const nodeId = generateNodeId(this.filePath, 'variable', id, el.start);
    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name: id,
      qualifiedName: id,
      filePath: this.filePath,
      language: 'xml',
      signature: `<${el.tag}>`,
      startLine: line,
      endLine: this.getLineNumber(el.end),
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: this.fileNodeId, target: nodeId, kind: 'contains' });

    const cls = el.attrs.class?.trim();
    if (cls) {
      this.unresolvedReferences.push({
        fromNodeId: nodeId,
        referenceName: javaFqnToQualifiedName(cls),
        referenceKind: 'instantiates',
        line,
        column: 0,
      });
    }
    return nodeId;
  }

  /**
   * `<bean>`-level attribute references: `parent=`, `depends-on=`
   * (comma/semicolon/whitespace-separated), `factory-bean=`, and p:/c:
   * namespace `-ref` attributes (`p:dataSource-ref="ds"`,
   * `c:service-ref="svc"`) — resolved by declared `xmlns:p|c` URI when
   * present, else the conventional `p`/`c` prefix (same pragmatic
   * "convention over configuration" MyBatis takes with unqualified
   * namespaces).
   */
  private emitBeanAttrRefs(el: XmlEl, fromNodeId: string): void {
    const line = this.getLineNumber(el.start);
    this.pushRef(fromNodeId, el.attrs.parent, line);
    this.pushRef(fromNodeId, el.attrs['factory-bean'], line);
    const dependsOn = el.attrs['depends-on'];
    if (dependsOn && dependsOn.trim()) {
      for (const dep of dependsOn.split(/[,;\s]+/)) this.pushRef(fromNodeId, dep, line);
    }
    for (const attrName of Object.keys(el.attrs)) {
      if (this.isNsRefAttr(attrName, this.pPrefix) || this.isNsRefAttr(attrName, this.cPrefix)) {
        this.pushRef(fromNodeId, el.attrs[attrName], line);
        continue;
      }
      // By-value class promotion (blind spot ⑶), p:/c: namespace LITERAL
      // form: `p:jobClass="com.example.job.SyncJob"` — same property-name
      // convention as the `<property name="jobClass" value="…">` form
      // above, just spelled as a namespace attribute instead of a child
      // element. Deliberately checked only for attrs that AREN'T already a
      // `-ref` attr (handled above) — a `-ref` attribute's value is a bean
      // name, never a class FQN.
      const literalName = this.nsLiteralPropertyName(attrName);
      if (literalName) this.pushClassPromotion(fromNodeId, literalName, el.attrs[attrName], line);
    }
  }

  private isNsRefAttr(attrName: string, prefix: string): boolean {
    return attrName.startsWith(`${prefix}:`) && attrName.endsWith('-ref');
  }

  /** `p:jobClass="…"` → `"jobClass"`; not a p:/c: namespace attr → `undefined`. */
  private nsLiteralPropertyName(attrName: string): string | undefined {
    for (const prefix of [this.pPrefix, this.cPrefix]) {
      if (attrName.startsWith(`${prefix}:`)) return attrName.slice(prefix.length + 1);
    }
    return undefined;
  }

  /**
   * The by-value form of a `<property>`/`<constructor-arg>`: either the
   * `value=` attribute, or (when that's absent) the text of a `<value>`
   * child element (`<property name="jobClass"><value>com.example.job
   * .SyncJob</value></property>` — equally common in older/verbose Spring
   * XML). `value=` wins when both are somehow present (shouldn't happen in
   * well-formed XML, but attribute form is the cheaper/more direct read).
   */
  private getPropertyValue(el: XmlEl): string | undefined {
    if (el.attrs.value !== undefined) return el.attrs.value;
    const valueChild = el.children.find((c) => localName(c.tag) === 'value');
    return valueChild ? this.getElementText(valueChild) : undefined;
  }

  /**
   * Inner text of an element with no element children of its own — e.g.
   * `<value>com.example.job.SyncJob</value>`. The lenient tree parser never
   * records text nodes (only tag/attrs/children — see `XmlEl`, and the
   * class doc's rationale for why: nothing else here needs element text),
   * so this re-derives it directly from `this.source` by locating the end
   * of the opening tag and the start of the matching close tag. A
   * self-closing element (`<value/>`) has no text by construction. A mixed-
   * content element (unexpected for `<value>`, but handled defensively)
   * yields only the text before its first child.
   *
   * The close-tag search is for THIS element's own literal `</tag` token
   * (not a bare `</`), searched from `el.end - 1`: adjacent same-offset
   * closing tags (`<value>x</value></property>`, the common no-whitespace
   * case) put the very next sibling's `</property` starting AT `el.end`
   * (`</value>`'s own close ends exactly where `</property>`'s begins) — a
   * bare `</` search anchored at `el.end` matches that sibling's closer
   * instead of this element's own, corrupting the text with a trailing
   * `</value>` tail. Anchoring the tag-specific search one position earlier
   * and requiring an exact tag-name match rules that out.
   */
  private getElementText(el: XmlEl): string {
    const src = this.source;
    const openTagEnd = src.indexOf('>', el.start);
    if (openTagEnd < 0 || src[openTagEnd - 1] === '/') return '';
    let textEnd: number;
    if (el.children.length > 0) {
      textEnd = el.children[0]!.start;
    } else {
      const closeStart = src.lastIndexOf(`</${el.tag}`, el.end - 1);
      textEnd = closeStart > openTagEnd ? closeStart : el.end;
    }
    return decodeXmlEntities(src.slice(openTagEnd + 1, textEnd)).trim();
  }

  /**
   * Emit the blind-spot-⑶ `instantiates` reference when `propName` is
   * class-shaped (`isClassLikePropertyName`) and `rawValue` is FQN-shaped
   * (`isFqnShapedValue`) — shared by all three surface forms (property/
   * constructor-arg `value=`, `<value>` child text, p:/c: namespace
   * literal). Reuses `javaFqnToQualifiedName` so this resolves through the
   * exact same channel as the headline `class=` promotion.
   */
  private pushClassPromotion(
    fromNodeId: string | null,
    propName: string | undefined,
    rawValue: string | undefined,
    line: number
  ): void {
    if (!fromNodeId || !propName || !isClassLikePropertyName(propName.trim())) return;
    const value = rawValue?.trim();
    if (!value || !isFqnShapedValue(value)) return;
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: javaFqnToQualifiedName(value),
      referenceKind: 'instantiates',
      line,
      column: 0,
    });
  }

  private emitImport(el: XmlEl): void {
    const raw = el.attrs.resource?.trim();
    if (!raw) return;
    // Strip the `classpath:`/`classpath*:`/`file:` resource prefix before
    // emitting: the resolver's file-path matcher (`matchByFilePath`) looks
    // up file nodes by basename via `path.split('/').pop()`, so a no-slash
    // resource like `classpath:other-context.xml` would otherwise carry the
    // prefix INTO the "basename" (`classpath:other-context.xml`), which
    // never matches any real file node's name and leaves the import edge
    // permanently dangling — the common, no-subdirectory case for this
    // reference channel.
    const resource = raw.replace(/^classpath\*?:/, '').replace(/^file:/, '');
    if (!resource) return;
    this.unresolvedReferences.push({
      fromNodeId: this.fileNodeId,
      referenceName: resource,
      referenceKind: 'imports',
      line: this.getLineNumber(el.start),
      column: 0,
    });
  }

  /**
   * `<alias name="target" alias="aka"/>` — make `ref="aka"` resolvable.
   * The Node type has no "extra names" slot, so the cheapest way to make an
   * ALIAS itself a resolvable name is a tiny synthetic bean-shaped node
   * named `aka` carrying a `references` edge to `target`: a ref-by-alias
   * then resolves in two hops (aka → target) through the exact same
   * exact-name matching real bean refs already go through, at the cost of
   * one extra node per `<alias>` tag (each justified by the edge it carries
   * — never a valueless leaf).
   */
  private emitAlias(el: XmlEl): void {
    const target = el.attrs.name?.trim();
    const aliasName = el.attrs.alias?.trim();
    if (!target || !aliasName) return;
    const line = this.getLineNumber(el.start);
    const nodeId = generateNodeId(this.filePath, 'variable', aliasName, el.start);
    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name: aliasName,
      qualifiedName: aliasName,
      filePath: this.filePath,
      language: 'xml',
      signature: `alias for "${target}"`,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: this.fileNodeId, target: nodeId, kind: 'contains' });
    this.unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: target,
      referenceKind: 'references',
      line,
      column: 0,
    });
  }

  /**
   * Push a bean→bean `references` edge, normalizing away the two ways a raw
   * attribute value can be a non-reference: empty/whitespace-only (`ref=""`
   * must never produce an empty referenceName) and a factory-dereference
   * `&` prefix (`ref="&factoryBean"` refers to the *factory bean itself*,
   * not the object it produces — stripped before matching, same as the
   * spec's ByteSpan-level treatment).
   */
  private pushRef(fromNodeId: string | null, raw: string | undefined, line: number): void {
    if (!fromNodeId || !raw) return;
    let v = raw.trim();
    if (!v) return;
    if (v.startsWith('&')) v = v.slice(1).trim();
    if (!v) return;
    this.unresolvedReferences.push({ fromNodeId, referenceName: v, referenceKind: 'references', line, column: 0 });
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private getLineNumber(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
