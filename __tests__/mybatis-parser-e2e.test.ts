import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

/**
 * End-to-end proof that the parser-backed MyBatis/iBatis extractor
 * (`src/extraction/mybatis-parser-extractor.ts`, opt-in via
 * `CODEGRAPH_MYBATIS_EXTRACTOR=parser`) drives the real
 * `mybatisJavaXmlEdges` Java->XML bridge (`src/resolution/callback-synthesizer.ts`)
 * through the full `CodeGraph.initSync` + `indexAll()` pipeline — not just the
 * extractor unit-tested in isolation (`__tests__/mybatis-parser-extractor.test.ts`).
 *
 * The headline case is iBatis `<sqlMap>`: the default regex `MyBatisExtractor`
 * is gated on `<mapper namespace=...>` and produces ZERO xml method nodes for
 * a `<sqlMap>` file, so the bridge has nothing to synthesize against. The
 * parser extractor (built on the `batis-xml` wasm parser) understands
 * `<sqlMap>` natively, so the bridge fires.
 *
 * Env-var propagation note: `CODEGRAPH_MYBATIS_EXTRACTOR` is read at
 * extraction time in `src/extraction/tree-sitter.ts`. `ExtractionOrchestrator`
 * only offloads parsing to a worker-thread pool when a compiled
 * `dist/extraction/parse-worker.js` exists next to the running `index.ts`
 * (`useWorker = fs.existsSync(parseWorkerPath)`); running from TS source under
 * vitest, no such file sits beside `src/extraction/index.ts`, so extraction
 * falls back to in-process parsing on the main thread and reads
 * `process.env` directly — confirmed empirically here (toggling the env var
 * between `it()` blocks in-process reliably flips the extractor). That is why
 * the regex-mode contrast assertions below are included rather than omitted.
 */

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function writeIbatisFixture(tmpDir: string): void {
  const javaDir = path.join(tmpDir, 'src/main/java/com/example/dao');
  const xmlDir = path.join(tmpDir, 'src/main/resources/sqlmaps');
  fs.mkdirSync(javaDir, { recursive: true });
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(
    path.join(javaDir, 'UserDao.java'),
    'package com.example.dao;\n' +
      'public interface UserDao {\n' +
      '  Object getById(long id);\n' +
      '  int insertUser(Object user);\n' +
      '}\n'
  );
  // iBatis 2 sqlMap, offline DOCTYPE (no network DTD fetch), #param#
  // placeholders, and a nested <selectKey> inside the insert statement.
  fs.writeFileSync(
    path.join(xmlDir, 'UserDao.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE sqlMap PUBLIC "-//ibatis.apache.org//DTD SQL Map 2.0//EN" "http://ibatis.apache.org/dtd/sql-map-2.dtd">\n' +
      '<sqlMap namespace="UserDao">\n' +
      '  <select id="getById" resultClass="User">\n' +
      '    SELECT * FROM users WHERE id = #id#\n' +
      '  </select>\n' +
      '  <insert id="insertUser" parameterClass="User">\n' +
      '    <selectKey resultClass="int" keyProperty="id">\n' +
      '      SELECT LAST_INSERT_ID()\n' +
      '    </selectKey>\n' +
      '    INSERT INTO users (name, email) VALUES (#name#, #email#)\n' +
      '  </insert>\n' +
      '</sqlMap>\n'
  );
}

function writeMybatisFixture(tmpDir: string): void {
  const javaDir = path.join(tmpDir, 'src/main/java/com/example/mapper');
  const xmlDir = path.join(tmpDir, 'src/main/resources/mappers');
  fs.mkdirSync(javaDir, { recursive: true });
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(
    path.join(javaDir, 'OrderMapper.java'),
    'package com.example.mapper;\n' +
      'public interface OrderMapper {\n' +
      '  Object findOrder(long id);\n' +
      '}\n'
  );
  fs.writeFileSync(
    path.join(xmlDir, 'OrderMapper.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n' +
      '<mapper namespace="com.example.mapper.OrderMapper">\n' +
      '  <select id="findOrder" resultType="Order">\n' +
      '    SELECT * FROM orders WHERE id = #{id}\n' +
      '  </select>\n' +
      '</mapper>\n'
  );
}

describe('MyBatis/iBatis parser extractor — real end-to-end Java->XML bridge', () => {
  let tmpDir: string | undefined;
  const savedEnv = process.env.CODEGRAPH_MYBATIS_EXTRACTOR;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    if (savedEnv === undefined) delete process.env.CODEGRAPH_MYBATIS_EXTRACTOR;
    else process.env.CODEGRAPH_MYBATIS_EXTRACTOR = savedEnv;
  });

  it('parser mode: bridges iBatis <sqlMap> UserDao.getById, splits <selectKey> into its own xml node, and bridges MyBatis OrderMapper.findOrder too', async () => {
    process.env.CODEGRAPH_MYBATIS_EXTRACTOR = 'parser';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-parser-e2e-'));
    writeIbatisFixture(tmpDir);
    writeMybatisFixture(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const javaMethods = methods.filter((m) => m.language === 'java');
    const xmlMethods = methods.filter((m) => m.language === 'xml');

    // --- iBatis <sqlMap>: the headline gap the regex extractor cannot see. ---
    const getByIdJava = javaMethods.find((m) => m.name === 'getById');
    const insertUserJava = javaMethods.find((m) => m.name === 'insertUser');
    expect(getByIdJava, 'Java UserDao.getById should be indexed').toBeDefined();
    expect(insertUserJava, 'Java UserDao.insertUser should be indexed').toBeDefined();

    const getByIdXml = xmlMethods.find((m) => m.qualifiedName === 'UserDao::getById');
    expect(getByIdXml, 'iBatis <select id="getById"> should produce an xml method node').toBeDefined();

    // Java -> XML bridge, synthesized by mybatisJavaXmlEdges.
    const getByIdEdge = cg
      .getOutgoingEdges(getByIdJava!.id)
      .find((e) => e.target === getByIdXml!.id && e.kind === 'calls');
    expect(getByIdEdge, 'UserDao.getById (java) should bridge to UserDao::getById (xml)').toBeDefined();
    expect(
      (getByIdEdge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy
    ).toBe('mybatis-java-xml');

    // <selectKey> is split into its own child statement, synthesized id
    // `"{parent_id}!selectKey"` by the batis-xml parser (confirmed via
    // node_modules/batis-xml/schema.d.ts and empirical extraction output).
    const selectKeyXml = xmlMethods.find((m) => m.qualifiedName === 'UserDao::insertUser!selectKey');
    expect(selectKeyXml, '<selectKey> should produce its own xml method node').toBeDefined();
    expect(selectKeyXml!.name).toBe('insertUser!selectKey');

    // The parent insert statement itself also bridges normally.
    const insertUserXml = xmlMethods.find((m) => m.qualifiedName === 'UserDao::insertUser');
    expect(insertUserXml, '<insert id="insertUser"> should produce an xml method node').toBeDefined();
    const insertEdge = cg
      .getOutgoingEdges(insertUserJava!.id)
      .find((e) => e.target === insertUserXml!.id && e.kind === 'calls');
    expect(insertEdge, 'UserDao.insertUser (java) should bridge to UserDao::insertUser (xml)').toBeDefined();

    // --- MyBatis <mapper>: both extractors handle this; parser mode must not regress it. ---
    const findOrderJava = javaMethods.find((m) => m.name === 'findOrder');
    const findOrderXml = xmlMethods.find(
      (m) => m.qualifiedName === 'com.example.mapper.OrderMapper::findOrder'
    );
    expect(findOrderJava, 'Java OrderMapper.findOrder should be indexed').toBeDefined();
    expect(findOrderXml, 'MyBatis <select id="findOrder"> should produce an xml method node').toBeDefined();
    const findOrderEdge = cg
      .getOutgoingEdges(findOrderJava!.id)
      .find((e) => e.target === findOrderXml!.id && e.kind === 'calls');
    expect(findOrderEdge, 'OrderMapper.findOrder (java) should bridge to its xml statement').toBeDefined();

    cg.close();
  });

  it('regex mode (default, no parser opt-in): iBatis <sqlMap> yields ZERO xml nodes, while MyBatis <mapper> still bridges', async () => {
    delete process.env.CODEGRAPH_MYBATIS_EXTRACTOR;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mybatis-regex-contrast-'));
    writeIbatisFixture(tmpDir);
    writeMybatisFixture(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const xmlMethods = methods.filter((m) => m.language === 'xml');

    // The regex MyBatisExtractor is gated on `<mapper namespace=...>` and
    // never recognizes `<sqlMap>` at all — this is the gap the parser
    // extractor exists to close.
    const ibatisXmlNodes = xmlMethods.filter((m) => m.qualifiedName.startsWith('UserDao::'));
    expect(ibatisXmlNodes, 'regex extractor must see zero statements in the iBatis sqlMap').toHaveLength(0);

    // The MyBatis <mapper> case is unaffected — both extractors handle it.
    const findOrderJava = methods.find((m) => m.language === 'java' && m.name === 'findOrder');
    const findOrderXml = xmlMethods.find(
      (m) => m.qualifiedName === 'com.example.mapper.OrderMapper::findOrder'
    );
    expect(findOrderJava).toBeDefined();
    expect(findOrderXml, 'regex extractor should still cover the MyBatis <mapper> statement').toBeDefined();
    const findOrderEdge = cg
      .getOutgoingEdges(findOrderJava!.id)
      .find((e) => e.target === findOrderXml!.id && e.kind === 'calls');
    expect(findOrderEdge, 'OrderMapper.findOrder should still bridge under regex mode').toBeDefined();

    cg.close();
  });
});
