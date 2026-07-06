import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MyBatisParserExtractor — a parser-backed alternative to the regex
 * `MyBatisExtractor`, built on the `batis-xml` package (a MyBatis/iBatis
 * mapper-XML parser compiled to WebAssembly, pure-JS to call, no native
 * addon — fits the existing web-tree-sitter precedent).
 *
 * It emits the SAME node/edge shape as the regex extractor (`method` nodes
 * qualified `<namespace>::<id>`, `contains` edges, `<include>` →
 * unresolved reference), so `mybatisJavaXmlEdges` and everything downstream
 * work unchanged. What it adds over the regex scan:
 *   - iBatis 2 `<sqlMap>` coverage (namespaced and `DAO.method`-style ids),
 *     which the `<mapper namespace=...>`-gated regex sees as zero statements;
 *   - correct handling of single-quoted attributes, XML comments, CDATA,
 *     and entities (a real parser, not a regex);
 *   - properly flattened dynamic SQL in the docstring — `<if>/<choose>/
 *     <foreach>` branches are expanded and placeholders normalized (`#{}`
 *     → `?`, `${}` → a `__BATIS_DYN__` sentinel) rather than crudely
 *     tag-stripped, so the FTS-indexed docstring reflects real SQL structure.
 *
 * Selected via `CODEGRAPH_MYBATIS_EXTRACTOR=parser` (see tree-sitter.ts);
 * the regex extractor remains the default. `batis-xml` is lazy-required so
 * its wasm module is only loaded when this extractor is actually used.
 */

// Minimal shape of the `batis-xml` JSON output that we consume. The full
// schema ships as `batis-xml/schema`; we mirror only the fields used here to
// avoid coupling to that module's resolution.
interface BxSpan {
  start: number;
  end: number;
}
interface BxSpanned<T> {
  value: T;
  span: BxSpan;
}
interface BxSqlString {
  text: string;
}
type BxSqlText =
  | { variants: Array<{ text: BxSqlString }> }
  | { union: { text: BxSqlString } };
interface BxIncludeRef {
  raw: string;
}
interface BxStatement {
  kind: string;
  span: BxSpan;
  id: BxSpanned<string> | null;
  sql: BxSqlText;
  includes: Array<BxSpanned<BxIncludeRef>>;
  param_class: BxSpanned<{ raw: string }> | null;
  result_class: BxSpanned<{ raw: string }> | null;
}
interface BxFragment {
  span: BxSpan;
  id: BxSpanned<string>;
  sql: BxSqlText;
  includes: Array<BxSpanned<BxIncludeRef>>;
}
interface BxMapper {
  namespace: BxSpanned<string> | null;
  statements: BxStatement[];
  fragments: BxFragment[];
}
interface BxParseResult {
  mapper: BxMapper | null;
}

const DOCSTRING_CAP = 400;

export class MyBatisParserExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  // Line starts in BYTE space: batis-xml reports byte offsets, so line
  // numbers must be derived from UTF-8 byte positions (multibyte-safe).
  private byteLineStarts: number[] = [];
  private sourceBytes: Buffer;

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.sourceBytes = Buffer.from(source, 'utf8');
    this.computeByteLineStarts();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const fileNode = this.createFileNode();

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const batis = require('batis-xml') as { parse(input: Uint8Array): string };
      const result = JSON.parse(batis.parse(this.sourceBytes)) as BxParseResult;
      if (result.mapper) {
        this.extractMapper(fileNode.id, result.mapper);
      }
    } catch (error) {
      this.errors.push({
        message: `MyBatis extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private extractMapper(fileNodeId: string, mapper: BxMapper): void {
    const namespace = mapper.namespace?.value ?? null;

    for (const stmt of mapper.statements) {
      if (!stmt.id) continue; // a statement without an id can't be qualified
      const { qualifiedName, name } = this.qualify(namespace, stmt.id.value);
      const startLine = this.byteLine(stmt.span.start);
      const nodeId = this.methodNodeId(qualifiedName, stmt.span.start, startLine);
      this.nodes.push({
        id: nodeId,
        kind: 'method',
        name,
        qualifiedName,
        filePath: this.filePath,
        language: 'xml',
        signature: this.buildSignature(stmt),
        startLine,
        endLine: this.byteLine(stmt.span.end),
        startColumn: 0,
        endColumn: 0,
        docstring: this.flattenSql(stmt.sql),
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      this.emitIncludes(nodeId, namespace, stmt.includes);
    }

    // `<sql>` fragments are method-shaped nodes too, so an `<include>`
    // elsewhere can resolve to them by qualified name.
    for (const frag of mapper.fragments) {
      const { qualifiedName, name } = this.qualify(namespace, frag.id.value);
      const startLine = this.byteLine(frag.span.start);
      const nodeId = this.methodNodeId(qualifiedName, frag.span.start, startLine);
      this.nodes.push({
        id: nodeId,
        kind: 'method',
        name,
        qualifiedName,
        filePath: this.filePath,
        language: 'xml',
        signature: '<sql>',
        startLine,
        endLine: this.byteLine(frag.span.end),
        startColumn: 0,
        endColumn: 0,
        docstring: this.flattenSql(frag.sql),
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      this.emitIncludes(nodeId, namespace, frag.includes);
    }
  }

  private emitIncludes(
    fromNodeId: string,
    namespace: string | null,
    includes: Array<BxSpanned<BxIncludeRef>>
  ): void {
    for (const inc of includes) {
      const raw = inc.value.raw;
      // A qualified refid (`ns.fragment`) maps its dots to `::`; a bare refid
      // resolves within the current namespace — matching the regex extractor.
      const refQualified = raw.includes('.')
        ? raw.replace(/\./g, '::')
        : namespace
          ? `${namespace}::${raw}`
          : raw;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: refQualified,
        referenceKind: 'references',
        line: this.byteLine(inc.span.start),
        column: 0,
      });
    }
  }

  /**
   * Build a `<namespace>::<id>` qualified name and simple name. When there is
   * no mapper namespace (iBatis sqlMaps often omit it) but the id itself is a
   * `Class.method` string, the segment before the last dot acts as the class,
   * so the Java↔XML bridge can still suffix-match by class name.
   */
  private qualify(namespace: string | null, id: string): { qualifiedName: string; name: string } {
    if (namespace) {
      return { qualifiedName: `${namespace}::${id}`, name: id };
    }
    const dot = id.lastIndexOf('.');
    if (dot >= 0) {
      return { qualifiedName: `${id.slice(0, dot)}::${id.slice(dot + 1)}`, name: id.slice(dot + 1) };
    }
    return { qualifiedName: id, name: id };
  }

  /**
   * Compute a node id for a mybatis method-shaped node (statement, `<sql>`
   * fragment, or `<selectKey>` child — all flow through the same statement
   * loop since batis-xml synthesizes the latter's id as `<id>!selectKey`).
   *
   * `generateNodeId` hashes `filePath:kind:name:line` and ignores byte
   * offset/column, so two statements sharing a qualifiedName AND a start
   * line (e.g. a same-line dual-dialect `databaseId="oracle"`/`"mysql"`
   * pair) would otherwise hash to the SAME id, and `INSERT OR REPLACE INTO
   * nodes` (id is the PRIMARY KEY) would silently drop the first one.
   *
   * Fix: mix the statement's byte offset into the hash INPUT via a NUL
   * separator (`\0`), which cannot appear in a qualifiedName, so it can't be
   * spoofed by any real identifier. This only disambiguates the id string
   * fed to the shared hash helper — the node's stored `qualifiedName` field
   * is untouched, so `mybatisJavaXmlEdges` (which matches on qualifiedName)
   * keeps working unchanged.
   */
  private methodNodeId(qualifiedName: string, byteOffset: number, startLine: number): string {
    return generateNodeId(this.filePath, 'method', `${qualifiedName}\0${byteOffset}`, startLine);
  }

  private buildSignature(stmt: BxStatement): string {
    const parts = [stmt.kind.toUpperCase()];
    if (stmt.param_class) parts.push(`param=${stmt.param_class.value.raw}`);
    if (stmt.result_class) parts.push(`result=${stmt.result_class.value.raw}`);
    return parts.join(' ');
  }

  /**
   * Flatten the parsed SQL for the FTS-indexed docstring. Distinct branch
   * variants are joined so every table/column across branches is searchable;
   * a union fallback (branch limit exceeded) carries its combined text.
   */
  private flattenSql(sql: BxSqlText): string {
    let text: string;
    if ('union' in sql) {
      text = sql.union.text.text;
    } else {
      const seen = new Set<string>();
      for (const v of sql.variants) {
        const t = v.text.text.replace(/\s+/g, ' ').trim();
        if (t) seen.add(t);
      }
      text = [...seen].join(' | ');
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, DOCSTRING_CAP);
  }

  private computeByteLineStarts(): void {
    this.byteLineStarts = [0];
    for (let i = 0; i < this.sourceBytes.length; i++) {
      if (this.sourceBytes[i] === 10) this.byteLineStarts.push(i + 1);
    }
  }

  private byteLine(byteOffset: number): number {
    let lo = 0;
    let hi = this.byteLineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.byteLineStarts[mid]! <= byteOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
