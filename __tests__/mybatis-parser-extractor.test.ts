import { describe, it, expect } from 'vitest';
import { MyBatisParserExtractor } from '../src/extraction/mybatis-parser-extractor';

const run = (path: string, xml: string) => new MyBatisParserExtractor(path, xml).extract();
const methods = (path: string, xml: string) =>
  run(path, xml).nodes.filter((n) => n.kind === 'method');
const qnames = (path: string, xml: string) => methods(path, xml).map((n) => n.qualifiedName);

describe('MyBatisParserExtractor — MyBatis parity', () => {
  it('emits a method node qualified <namespace>::<id> for a mapper statement', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById" resultType="User">SELECT * FROM users WHERE id=#{id}</select>' +
      '</mapper>';
    expect(qnames('FooMapper.xml', xml)).toContain('com.example.FooMapper::getById');
  });

  it('emits <sql> fragments as nodes and <include> as an unresolved reference', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<sql id="cols">id, name</sql>' +
      '<select id="getById">SELECT <include refid="cols"/> FROM users</select>' +
      '</mapper>';
    const r = run('FooMapper.xml', xml);
    expect(r.nodes.some((n) => n.qualifiedName === 'com.example.FooMapper::cols')).toBe(true);
    expect(r.unresolvedReferences.map((u) => u.referenceName)).toContain(
      'com.example.FooMapper::cols'
    );
  });

  it('flattens dynamic SQL and normalizes placeholders in the docstring', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT <include refid="cols"/> FROM users WHERE id=#{id}</select>' +
      '</mapper>';
    const doc = methods('FooMapper.xml', xml).find((n) => n.name === 'getById')!.docstring!;
    // #{id} normalized to ?, and the include rendered as its token (not raw tag text).
    expect(doc).toContain('id=?');
    expect(doc).toContain('batis:include(cols)');
    expect(doc).not.toContain('#{');
  });

  it('emits only a file node for non-mapper XML', () => {
    const xml = '<project><groupId>x</groupId><artifactId>y</artifactId></project>';
    expect(methods('pom.xml', xml)).toHaveLength(0);
    expect(run('pom.xml', xml).nodes.filter((n) => n.kind === 'file')).toHaveLength(1);
  });
});

describe('MyBatisParserExtractor — iBatis coverage (the regex extractor sees zero here)', () => {
  it('covers a namespaced iBatis <sqlMap>', () => {
    const xml =
      '<sqlMap namespace="UserDao">' +
      '<select id="getById" resultClass="User">SELECT * FROM users WHERE id = #id#</select>' +
      '</sqlMap>';
    expect(qnames('UserDao.xml', xml)).toContain('UserDao::getById');
  });

  it('covers a namespace-less iBatis <sqlMap> with DAO.method ids', () => {
    const xml =
      '<sqlMap>' +
      '<select id="UserDao.getById">SELECT 1</select>' +
      '</sqlMap>';
    // The segment before the last dot acts as the class so the Java bridge
    // can still suffix-match by class name.
    expect(qnames('sqlmap.xml', xml)).toContain('UserDao::getById');
  });

  it('normalizes iBatis #var# placeholders in the docstring', () => {
    const xml =
      '<sqlMap namespace="UserDao">' +
      '<select id="getById">SELECT * FROM users WHERE id = #id#</select>' +
      '</sqlMap>';
    const doc = methods('UserDao.xml', xml).find((n) => n.name === 'getById')!.docstring!;
    expect(doc).toContain('id = ?');
    expect(doc).not.toContain('#id#');
  });
});

describe('MyBatisParserExtractor — robustness', () => {
  it('accepts single-quoted attributes', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      "<select id='getById'>SELECT 1</select></mapper>";
    expect(qnames('FooMapper.xml', xml)).toContain('com.example.FooMapper::getById');
  });

  it('ignores statements inside XML comments', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<!-- <select id="dead">SELECT 1</select> -->' +
      '<select id="live">SELECT 2</select></mapper>';
    const names = methods('FooMapper.xml', xml).map((n) => n.name);
    expect(names).toContain('live');
    expect(names).not.toContain('dead');
  });

  it('reports the correct startLine past multibyte (non-ASCII) content', () => {
    // The Korean comment on line 1 is multibyte in UTF-8; a byte-offset →
    // line mapping that ignored byte width would land the <select> on the
    // wrong line. It is on document line 2.
    const xml =
      '<mapper namespace="com.example.FooMapper"><!-- 한국어 주석 여러 글자 설명 -->\n' +
      '<select id="getById">SELECT 1</select></mapper>';
    const stmt = methods('FooMapper.xml', xml).find((n) => n.name === 'getById')!;
    expect(stmt.startLine).toBe(2);
  });
});
