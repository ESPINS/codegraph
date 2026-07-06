import { describe, it, expect } from 'vitest';
import { MyBatisExtractor } from '../src/extraction/mybatis-extractor';

const methods = (path: string, xml: string) =>
  new MyBatisExtractor(path, xml).extract().nodes.filter((n) => n.kind === 'method');

describe('MyBatisExtractor (regex) — node id disambiguation', () => {
  it('disambiguates a SAME-LINE dual-dialect pair by byte offset (no id collision, no data loss)', () => {
    // Regression: both <select> sit on ONE line, so they share a
    // qualifiedName AND a start line. The node id used to hash only
    // filePath:kind:qualifiedName:startLine, so both hashed to the same id
    // and `INSERT OR REPLACE INTO nodes` (id is the PRIMARY KEY) silently
    // dropped the first. The id now folds in the statement's byte offset so
    // the two stay distinct. Mirrors the parser-extractor regression test.
    const xml =
      '<mapper namespace="com.example.UserMapper">' +
      '<select id="findUser" databaseId="oracle">SELECT * FROM users WHERE ROWNUM = 1</select>' +
      '<select id="findUser" databaseId="mysql">SELECT * FROM users LIMIT 1</select>' +
      '</mapper>';
    const found = methods('UserMapper.xml', xml);
    expect(found).toHaveLength(2);
    // Same qualifiedName AND same start line (both on line 1) — the
    // collision precondition...
    expect(found.every((n) => n.qualifiedName === 'com.example.UserMapper::findUser')).toBe(true);
    expect(new Set(found.map((n) => n.startLine)).size).toBe(1);
    // ...yet distinct node ids, so neither node overwrites the other on insert.
    expect(new Set(found.map((n) => n.id)).size).toBe(2);
    // Neither dialect's SQL body is lost.
    expect(new Set(found.map((n) => n.docstring)).size).toBe(2);
  });
});
