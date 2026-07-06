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

  it('reports the correct startLine past multibyte content (statement mid-document)', () => {
    // Five multibyte (3-byte-per-char) comment lines inflate the target's
    // byte offset far beyond its char offset; the trailing statements extend
    // the document so a char-space line lookup fed a byte offset overshoots
    // (verified empirically: to line 10). The correct byte-space mapping
    // reports line 6. The statement must NOT sit on the last line, or a
    // char-space lookup would clamp to the right answer by accident.
    const xml =
      '<mapper namespace="com.example.FooMapper"><!-- 한국어 첫째 줄 주석 여러 글자입니다 매우 긴 설명 -->\n' +
      '<!-- 둘째 줄 한국어 주석 여러 글자입니다 매우 긴 설명 -->\n' +
      '<!-- 셋째 줄 한국어 주석 여러 글자입니다 매우 긴 설명 -->\n' +
      '<!-- 넷째 줄 한국어 주석 여러 글자입니다 매우 긴 설명 -->\n' +
      '<!-- 다섯째 줄 한국어 주석 여러 글자입니다 매우 긴 설명 -->\n' +
      '<select id="target">SELECT 1</select>\n' +
      '<select id="after1">SELECT 2</select>\n' +
      '<select id="after2">SELECT 3</select>\n' +
      '<select id="after3">SELECT 4</select>\n' +
      '</mapper>';
    const found = methods('FooMapper.xml', xml);
    expect(found.find((n) => n.name === 'target')!.startLine).toBe(6);
    // A later statement's line is byte-offset-dependent too — a second guard.
    expect(found.find((n) => n.name === 'after3')!.startLine).toBe(9);
  });

  it('normalizes ${} to the __BATIS_DYN__ sentinel in the docstring', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="listing">SELECT * FROM t ORDER BY ${sortColumn}</select></mapper>';
    const doc = methods('FooMapper.xml', xml).find((n) => n.name === 'listing')!.docstring!;
    expect(doc).toContain('__BATIS_DYN__');
    expect(doc).not.toContain('${');
  });

  it('flattens a branch-limit-exceeded statement via the union fallback', () => {
    // Six <if> branches = 2^6 = 64 combinations, over batis-xml's cap of 32,
    // so the SQL comes back as a single union of all branch text. The node
    // must still be emitted with that flattened text in its docstring.
    let body = 'SELECT 1';
    for (let i = 0; i < 6; i++) body += `<if test="c${i}"> AND x${i} = 1</if>`;
    const xml = `<mapper namespace="com.example.FooMapper"><select id="wide">${body}</select></mapper>`;
    const stmt = methods('FooMapper.xml', xml).find((n) => n.name === 'wide')!;
    expect(stmt).toBeDefined();
    expect(stmt.docstring).toContain('x5 = 1');
  });

  it('gives <sql> fragment nodes a flattened docstring (FTS parity)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<sql id="cols">id, name, email</sql>' +
      '<select id="getById">SELECT <include refid="cols"/> FROM users</select></mapper>';
    const frag = methods('FooMapper.xml', xml).find((n) => n.name === 'cols')!;
    expect(frag.docstring).toContain('id, name, email');
  });
});

// Synthetic mapper XML adapted verbatim from batis-xml's own conformance
// corpus — the cases a real parser handles but a regex scan cannot. All
// synthetic; no proprietary source.
describe('MyBatisParserExtractor — corpus fixtures', () => {
  it('iBatis <sqlMap> with a doubled-delimiter escape and a DAO.method id', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sqlMap PUBLIC "-//ibatis.apache.org//DTD SQL Map 2.0//EN"
  "http://ibatis.apache.org/dtd/sql-map-2.dtd">
<sqlMap>
  <select id="widgetDAO.selectIntoTempTable" parameterClass="map" resultClass="widget">
    SELECT widget_id, widget_name INTO ##widget_tmp
    FROM demo_widget WHERE group_code = #groupCode#
  </select>
</sqlMap>`;
    const stmt = methods('WidgetDAO.xml', xml).find((n) => n.name === 'selectIntoTempTable')!;
    expect(stmt.qualifiedName).toBe('widgetDAO::selectIntoTempTable');
    // ## → literal #, #groupCode# → ?  (neither survives verbatim)
    expect(stmt.docstring).toContain('INTO #widget_tmp');
    expect(stmt.docstring).not.toContain('##');
    expect(stmt.docstring).toContain('group_code = ?');
  });

  it('MyBatis comparison operators inside CDATA survive with placeholders normalized', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
  "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.demo.mapper.WidgetMapper">
  <select id="searchWidgetsByPriceRange" resultType="com.example.demo.model.Widget">
    SELECT widget_id, widget_name FROM demo_widget
    <![CDATA[
    WHERE widget_price > #{minPrice}
      AND widget_price < #{maxPrice}
      AND created_at >= #{startDate}
    ]]>
  </select>
</mapper>`;
    const doc = methods('WidgetMapper.xml', xml).find(
      (n) => n.name === 'searchWidgetsByPriceRange'
    )!.docstring!;
    expect(doc).toContain('widget_price > ?');
    expect(doc).toContain('widget_price < ?');
  });

  it('iBatis $var$ dynamic column marker normalizes to the sentinel', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sqlMap PUBLIC "-//ibatis.apache.org//DTD SQL Map 2.0//EN"
  "http://ibatis.apache.org/dtd/sql-map-2.dtd">
<sqlMap>
  <select id="widgetDAO.selectSorted" parameterClass="map" resultClass="widget">
    SELECT widget_id, widget_name
    FROM demo_widget
    ORDER BY $sortColumn$ ASC
  </select>
</sqlMap>`;
    const stmt = methods('WidgetDAO.xml', xml).find((n) => n.name === 'selectSorted')!;
    expect(stmt.qualifiedName).toBe('widgetDAO::selectSorted');
    expect(stmt.docstring).toContain('ORDER BY __BATIS_DYN__');
  });
});

describe('MyBatisParserExtractor — databaseId dual-dialect statements', () => {
  // Shape adapted from a real legacy iBatis/MyBatis batch codebase that
  // declares the SAME statement id twice with different vendor databaseId
  // (oracle/mysql), each with its own dialect-specific SQL body. The wrapper
  // never reads `database_id` from batis-xml's model (grep-confirmed), so
  // this pins the OBSERVED behavior rather than an assumed one: both
  // statements are emitted as separate method nodes sharing one
  // qualifiedName, distinguished by span (startLine/endLine) and each
  // retaining its own docstring — no databaseId field appears anywhere in
  // the output, and neither SQL body is lost.
  it('emits both dialect statements as distinct nodes under the same qualifiedName, each keeping its own SQL', () => {
    const xml = `<mapper namespace="com.example.UserMapper">
  <select id="findUser" databaseId="oracle" resultType="User">
    SELECT * FROM users WHERE ROWNUM = 1 AND id = #{id}
  </select>
  <select id="findUser" databaseId="mysql" resultType="User">
    SELECT * FROM users WHERE id = #{id} LIMIT 1
  </select>
</mapper>`;
    const found = methods('UserMapper.xml', xml);
    expect(found).toHaveLength(2);
    expect(found.every((n) => n.qualifiedName === 'com.example.UserMapper::findUser')).toBe(true);
    // Distinct spans keep the two nodes distinguishable; their node ids are
    // distinct because the id folds in each statement's byte offset (see the
    // same-line regression test below and `methodNodeId` in the extractor).
    expect(new Set(found.map((n) => n.startLine)).size).toBe(2);
    expect(new Set(found.map((n) => n.id)).size).toBe(2);
    // Neither dialect's SQL is silently dropped.
    expect(found.some((n) => n.docstring?.includes('ROWNUM = 1'))).toBe(true);
    expect(found.some((n) => n.docstring?.includes('LIMIT 1'))).toBe(true);
    // No `databaseId`/`database_id` field is represented on the emitted
    // nodes at all — the wrapper simply doesn't read it.
    expect(found.every((n) => !('databaseId' in n) && !('database_id' in n))).toBe(true);
  });

  it('disambiguates a SAME-LINE dual-dialect pair by byte offset (no id collision, no data loss)', () => {
    // Regression: both statements sit on ONE line, so they share a
    // qualifiedName AND a startLine. A startLine-only node id would hash to
    // the same value for both, and `INSERT OR REPLACE INTO nodes` (id is the
    // PRIMARY KEY) would silently drop the first. The id must fold in each
    // statement's byte offset so the two stay distinct.
    const xml =
      '<mapper namespace="com.example.UserMapper">' +
      '<select id="findUser" databaseId="oracle">SELECT * FROM users WHERE ROWNUM = 1</select>' +
      '<select id="findUser" databaseId="mysql">SELECT * FROM users LIMIT 1</select>' +
      '</mapper>';
    const found = methods('UserMapper.xml', xml);
    expect(found).toHaveLength(2);
    // Same qualifiedName AND same startLine (both on line 1) — the collision
    // precondition...
    expect(found.every((n) => n.qualifiedName === 'com.example.UserMapper::findUser')).toBe(true);
    expect(new Set(found.map((n) => n.startLine)).size).toBe(1);
    // ...yet distinct node ids, so neither node overwrites the other on insert.
    expect(new Set(found.map((n) => n.id)).size).toBe(2);
    expect(found.some((n) => n.docstring?.includes('ROWNUM = 1'))).toBe(true);
    expect(found.some((n) => n.docstring?.includes('LIMIT 1'))).toBe(true);
  });
});

describe('MyBatisParserExtractor — <selectKey> node synthesis', () => {
  it('emits both the parent insert node and its "<id>!selectKey" child node', () => {
    const xml =
      '<mapper namespace="com.example.UserMapper">' +
      '<insert id="insertUser">' +
      '<selectKey keyProperty="id" resultType="int" order="BEFORE">SELECT nextval(\'user_seq\')</selectKey>' +
      'INSERT INTO users (id, name) VALUES (#{id}, #{name})' +
      '</insert>' +
      '</mapper>';
    const found = methods('UserMapper.xml', xml);
    const names = found.map((n) => n.name);
    expect(names).toContain('insertUser');
    expect(names).toContain('insertUser!selectKey');
    const parent = found.find((n) => n.name === 'insertUser')!;
    const key = found.find((n) => n.name === 'insertUser!selectKey')!;
    expect(parent.qualifiedName).toBe('com.example.UserMapper::insertUser');
    expect(key.qualifiedName).toBe('com.example.UserMapper::insertUser!selectKey');
    expect(key.docstring).toContain("nextval('user_seq')");
  });
});
