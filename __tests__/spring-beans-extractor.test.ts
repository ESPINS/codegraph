import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { CodeGraph } from '../src';
import type { UnresolvedReference, Node } from '../src/types';

// Spring beans XML extractor. Modeled on mybatis-extractor-robustness.test.ts's
// conventions (extractFromSource, synthetic com.example.* fixtures). Covers
// routing, bean-node extraction (incl. anonymous/inner/nested-profile), the
// headline bean->class `instantiates` edge, every bean->bean `references`
// channel (incl. collection recursion and the Quartz `<list><ref>` shape),
// alias resolution, `<import>`, the shared leniency contract with MyBatis,
// id-bearing NamespacedElement (jee/util) nodes, and negatives.

const result = (xml: string, file = 'applicationContext.xml') => extractFromSource(file, xml);

const beanNodes = (xml: string, file = 'applicationContext.xml'): Node[] =>
  result(xml, file).nodes.filter((n) => n.kind === 'variable');

const refs = (xml: string, file = 'applicationContext.xml'): UnresolvedReference[] =>
  result(xml, file).unresolvedReferences;

const beanByName = (xml: string, name: string, file = 'applicationContext.xml'): Node | undefined =>
  beanNodes(xml, file).find((n) => n.name === name);

/** references-kind refs whose fromNodeId is the given bean's node id. */
const refsFrom = (xml: string, fromId: string, file = 'applicationContext.xml'): UnresolvedReference[] =>
  refs(xml, file).filter((r) => r.fromNodeId === fromId && r.referenceKind === 'references');

describe('Spring beans extractor — routing', () => {
  it('routes a <beans> root to the Spring beans extractor (variable nodes, no method nodes)', () => {
    const xml = '<beans><bean id="foo" class="com.example.Foo"/></beans>';
    const r = result(xml);
    expect(r.nodes.some((n) => n.kind === 'variable' && n.name === 'foo')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'method')).toBe(false);
  });

  it('still routes a <mapper namespace> root to MyBatis (method nodes, no variable nodes)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT 1</select></mapper>';
    const r = result(xml, 'FooMapper.xml');
    expect(r.nodes.some((n) => n.kind === 'method' && n.name === 'getById')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'variable')).toBe(false);
  });

  it('leaves non-mapper, non-beans XML (pom.xml) with only a file node', () => {
    const xml = '<project><groupId>x</groupId><artifactId>y</artifactId></project>\n';
    const r = result(xml, 'pom.xml');
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.kind).toBe('file');
  });

  it('routes a bare <beans> root (no springframework xmlns) the same as a schema-declaring one', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<beans xmlns="http://www.springframework.org/schema/beans">' +
      '<bean id="foo" class="com.example.Foo"/></beans>';
    expect(beanByName(xml, 'foo')).toBeDefined();
  });

  it('routes a prefixed <beans:beans> root (Spring Security style) and resolves prefixed <beans:ref>', () => {
    const xml =
      '<beans:beans xmlns:beans="http://www.springframework.org/schema/beans">' +
      '<beans:bean id="a" class="com.example.A">' +
      '<beans:property name="dep"><beans:ref bean="b"/></beans:property>' +
      '</beans:bean></beans:beans>';
    const a = beanByName(xml, 'a');
    expect(a).toBeDefined();
    expect(refsFrom(xml, a!.id).map((r) => r.referenceName)).toContain('b');
  });
});

describe('Spring beans extractor — bean node extraction', () => {
  it('names a bean node by id', () => {
    const bean = beanByName('<beans><bean id="fooService" class="com.example.FooServiceImpl"/></beans>', 'fooService');
    expect(bean).toBeDefined();
    expect(bean!.qualifiedName).toBe('fooService');
    expect(bean!.language).toBe('xml');
  });

  it('falls back to the first name= token when id is absent', () => {
    const xml = '<beans><bean name="primary,alt1 alt2" class="com.example.X"/></beans>';
    expect(beanByName(xml, 'primary')).toBeDefined();
    expect(beanByName(xml, 'alt1')).toBeDefined();
  });

  it('registers every name= token as a resolvable secondary name (id ∪ names ∪ alias contract)', () => {
    const xml = '<beans><bean id="foo" name="alt1, alt2" class="com.example.X"/></beans>';
    const alt1 = beanByName(xml, 'alt1');
    const alt2 = beanByName(xml, 'alt2');
    expect(alt1).toBeDefined();
    expect(alt2).toBeDefined();
    const r = refs(xml);
    expect(r.some((x) => x.fromNodeId === alt1!.id && x.referenceKind === 'references' && x.referenceName === 'foo')).toBe(true);
    expect(r.some((x) => x.fromNodeId === alt2!.id && x.referenceKind === 'references' && x.referenceName === 'foo')).toBe(true);
  });

  it('dedupes name= tokens so name="b,b" does not emit a duplicate node for "b"', () => {
    const xml = '<beans><bean id="foo" name="b,b" class="com.example.X"/></beans>';
    const bNodes = beanNodes(xml).filter((n) => n.name === 'b');
    expect(bNodes).toHaveLength(1);
  });

  it('names an id-less, name-less bean by its class in <Simple$anon@line> form', () => {
    const xml = '<beans>\n<bean class="com.example.Anonymous"/>\n</beans>';
    const anon = beanNodes(xml).find((n) => n.name.startsWith('<Anonymous$anon@'));
    expect(anon).toBeDefined();
    expect(anon!.name).toBe('<Anonymous$anon@2>');
  });

  it('emits no node for a <bean> with neither name/id/class nor parent/factory-bean', () => {
    const xml = '<beans><bean/></beans>';
    expect(beanNodes(xml)).toHaveLength(0);
  });

  it('still emits an anon node for a top-level <bean parent="…"> (no id/name/class) so the parent ref is not dropped', () => {
    const xml = '<beans><bean parent="base"/></beans>';
    const anon = beanNodes(xml).find((n) => n.name.startsWith('<bean$anon@'));
    expect(anon).toBeDefined();
    expect(refsFrom(xml, anon!.id).map((r) => r.referenceName)).toContain('base');
  });

  it('recurses into an inner (constructor-arg) bean and links it to its outer bean via contains', () => {
    const xml =
      '<beans>' +
      '<bean id="outer" class="com.example.Outer">' +
      '<constructor-arg><bean class="com.example.Inner"/></constructor-arg>' +
      '</bean></beans>';
    const outer = beanByName(xml, 'outer');
    const inner = beanNodes(xml).find((n) => n.name.startsWith('<Inner$anon@'));
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    const r = result(xml);
    expect(
      r.edges.some((e) => e.kind === 'contains' && e.source === outer!.id && e.target === inner!.id)
    ).toBe(true);
  });

  it('extracts beans nested inside a <beans profile="…"> block, contained by the file (no profile node)', () => {
    const xml = '<beans><beans profile="dev"><bean id="devBean" class="com.example.Dev"/></beans></beans>';
    const devBean = beanByName(xml, 'devBean');
    expect(devBean).toBeDefined();
    const r = result(xml);
    const fileNode = r.nodes.find((n) => n.kind === 'file')!;
    expect(
      r.edges.some((e) => e.kind === 'contains' && e.source === fileNode.id && e.target === devBean!.id)
    ).toBe(true);
  });
});

describe('Spring beans extractor — bean→class instantiates edge (headline)', () => {
  it('emits an instantiates unresolvedReference in Java-qualifiedName shape (package::Class)', () => {
    const xml = '<beans><bean id="fooService" class="com.example.service.FooServiceImpl"/></beans>';
    const bean = beanByName(xml, 'fooService')!;
    const r = refs(xml).filter((x) => x.fromNodeId === bean.id && x.referenceKind === 'instantiates');
    expect(r).toHaveLength(1);
    // NOT the raw dotted FQN — converted so it exact-matches the Java
    // extractor's own `<dotted.package>::<ClassName>` qualifiedName shape.
    expect(r[0]!.referenceName).toBe('com.example.service::FooServiceImpl');
  });

  it('emits instantiates for a bare (package-less) class name unchanged', () => {
    const xml = '<beans><bean id="x" class="TopLevelBean"/></beans>';
    const bean = beanByName(xml, 'x')!;
    const r = refs(xml).filter((x) => x.fromNodeId === bean.id && x.referenceKind === 'instantiates');
    expect(r[0]!.referenceName).toBe('TopLevelBean');
  });

  it('maps a static-nested-class $ separator to :: so it matches the Java extractor\'s qualifiedName shape', () => {
    const xml = '<beans><bean id="x" class="com.example.Outer$Inner"/></beans>';
    const bean = beanByName(xml, 'x')!;
    const r = refs(xml).filter((x) => x.fromNodeId === bean.id && x.referenceKind === 'instantiates');
    expect(r[0]!.referenceName).toBe('com.example::Outer::Inner');
  });

  it('treats class="" as absent — no instantiates reference, but the bean node still exists (id present)', () => {
    const xml = '<beans><bean id="x" class=""/></beans>';
    const bean = beanByName(xml, 'x');
    expect(bean).toBeDefined();
    expect(refs(xml).some((r) => r.referenceKind === 'instantiates')).toBe(false);
  });
});

describe('Spring beans extractor — bean→bean references channels', () => {
  it('property ref=', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="dep" ref="b"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('constructor-arg ref=', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><constructor-arg ref="b"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('<ref bean="…">', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="dep"><ref bean="b"/></property></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('<ref local="…"> (legacy form)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="dep"><ref local="b"/></property></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('<idref bean="…">', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="depName"><idref bean="b"/></property></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('parent=', () => {
    const xml = '<beans><bean id="a" class="com.example.A" parent="base"/></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('base');
  });

  it('depends-on= (comma/semicolon/whitespace separated)', () => {
    const xml = '<beans><bean id="a" class="com.example.A" depends-on="b, c;d e"/></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toEqual(expect.arrayContaining(['b', 'c', 'd', 'e']));
  });

  it('factory-bean=', () => {
    const xml = '<beans><bean id="a" factory-bean="factory" factory-method="create"/></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('factory');
  });

  it('strips a leading & (factory-bean dereference marker) from a ref value', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="dep" ref="&factoryBean"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('factoryBean');
  });

  it('decodes &amp; before stripping the factory-bean dereference marker (well-formed XML)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="dep" ref="&amp;factoryBean"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('factoryBean');
    expect(names).not.toContain('amp;factoryBean');
  });

  it('guards against a String.fromCodePoint RangeError on an out-of-range numeric entity (&#x110000;), still extracting the rest of the file', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A" note="&#x110000;"/>' +
      '<bean id="b" class="com.example.B"/></beans>';
    expect(() => result(xml)).not.toThrow();
    // Without the guard, the thrown RangeError escapes to extract()'s catch
    // and degrades the whole file to file-node-only — both beans below,
    // including the one carrying the bad entity, must still come through.
    expect(beanByName(xml, 'a')).toBeDefined();
    expect(beanByName(xml, 'b')).toBeDefined();
  });

  it('p:*-ref and c:*-ref via the conventional prefix (no xmlns:p/c declared)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A" p:service-ref="svc" c:helper-ref="hlp"/></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toEqual(expect.arrayContaining(['svc', 'hlp']));
  });

  it('p:*-ref via a declared, non-conventional xmlns prefix', () => {
    const xml =
      '<beans xmlns:pp="http://www.springframework.org/schema/p">' +
      '<bean id="a" class="com.example.A" pp:service-ref="svc"/></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('svc');
  });

  it('lookup-method@bean', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><lookup-method name="getX" bean="b"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('replaced-method@replacer', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><replaced-method name="doIt" replacer="b"/></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id).map((r) => r.referenceName)).toContain('b');
  });

  it('<map><entry key-ref= value-ref=>', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="m">' +
      '<map><entry key-ref="k" value-ref="v"/></map>' +
      '</property></bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toEqual(expect.arrayContaining(['k', 'v']));
  });

  it('<set>/<array> containing <ref>', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="s"><set><ref bean="s1"/></set></property>' +
      '<property name="arr"><array><ref bean="a1"/></array></property>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toEqual(expect.arrayContaining(['s1', 'a1']));
  });

  it('<props> is skipped (literal key/value, never a ref channel)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A"><property name="cfg">' +
      '<props><prop key="x">val</prop></props>' +
      '</property></bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id)).toHaveLength(0);
  });

  it('Quartz-shaped <property><list><ref/></list></property> (collection recursion, the load-bearing case)', () => {
    const xml =
      '<beans>' +
      '<bean id="cronTrigger" class="org.springframework.scheduling.quartz.CronTriggerFactoryBean"/>' +
      '<bean id="scheduler" class="com.example.SchedulerFactory">' +
      '<property name="triggers"><list><ref bean="cronTrigger"/></list></property>' +
      '</bean></beans>';
    const scheduler = beanByName(xml, 'scheduler')!;
    expect(refsFrom(xml, scheduler.id).map((r) => r.referenceName)).toContain('cronTrigger');
  });

  it('a <ref> nested inside an inner (anonymous) bean is scoped to the inner bean, not the outer one', () => {
    const xml =
      '<beans><bean id="outer" class="com.example.Outer">' +
      '<property name="inner">' +
      '<bean class="com.example.Inner"><property name="dep" ref="deep"/></bean>' +
      '</property></bean></beans>';
    const outer = beanByName(xml, 'outer')!;
    const inner = beanNodes(xml).find((n) => n.name.startsWith('<Inner$anon@'))!;
    expect(refsFrom(xml, inner.id).map((r) => r.referenceName)).toContain('deep');
    expect(refsFrom(xml, outer.id).map((r) => r.referenceName)).not.toContain('deep');
  });
});

describe('Spring beans extractor — PLACEHOLDER-REF DEFAULT (v1.1: ref="${env.prop:defaultBeanName}")', () => {
  it('resolves ref="${env.prop:defaultBeanName}" to the DEFAULT bean name, not the raw placeholder string', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="${env.prop:defaultBean}"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('defaultBean');
    expect(names).not.toContain('${env.prop:defaultBean}');
  });

  it('drops a placeholder with no default (${prop} alone) — unevaluable, no reference emitted', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="${env.prop}"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id)).toHaveLength(0);
  });

  it('does NOT resolve a default when the placeholder is only part of the value (prefix${env.prop:default}) — falls through as the raw literal, unmatched', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="prefix${env.prop:defaultBean}"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('prefix${env.prop:defaultBean}');
    expect(names).not.toContain('defaultBean');
  });

  it('does NOT apply DEFAULT-extraction to class= (bean-ref channels only, never the by-value class attribute) — pins the mangled placeholder emitted instead', () => {
    const xml = '<beans><bean id="a" class="${env.prop:com.example.DefaultClass}"/></beans>';
    const a = beanByName(xml, 'a')!;
    const instantiates = refs(xml).filter((x) => x.fromNodeId === a.id && x.referenceKind === 'instantiates');
    expect(instantiates.some((x) => x.referenceName === 'com.example::DefaultClass')).toBe(false);
    // class= is never routed through pushRef's placeholder handling — it goes
    // straight to javaFqnToQualifiedName, which blindly rewrites the LAST
    // `.`->`::` and every `$`->`::` with no placeholder-awareness. Pin what
    // that actually produces so a future change to either function is forced
    // to notice this dangling, mangled reference rather than leaving it as
    // invisible garbage a passing test doesn't surface.
    expect(instantiates.map((x) => x.referenceName)).toContain('::{env.prop:com.example::DefaultClass}');
  });

  it('also resolves the default through the p:*-ref namespace channel (same shared pushRef path)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A" p:service-ref="${env.svc:defaultSvc}"/></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('defaultSvc');
  });

  it('also resolves the default through the depends-on= attribute channel (same shared pushRef path)', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A" depends-on="${env.dep:defaultDep}"/></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('defaultDep');
  });

  it('does NOT resolve a default when the placeholder is only a SUFFIX of the value (${env.prop:default}Suffix) — falls through as the raw literal, unmatched', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="${env.prop:defaultBean}Suffix"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('${env.prop:defaultBean}Suffix');
    expect(names).not.toContain('defaultBean');
  });

  it('drops a placeholder default containing a hyphen (${prop:a-b}) — a legal hyphenated Spring bean name that the DEFAULT regex deliberately does not capture', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="${env.prop:my-bean}"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    expect(refsFrom(xml, a.id)).toHaveLength(0);
  });

  it('a nested placeholder default (${p:${q}}) matches neither placeholder regex and falls through as the raw literal, unmatched', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref="${env.prop:${env.fallback}}"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toContain('${env.prop:${env.fallback}}');
  });
});

describe('Spring beans extractor — by-value class promotion (blind spot ⑶: jobClass/targetClass/…)', () => {
  it('promotes <property name="jobClass" value="…"> (attribute value form, the classic Quartz shape)', () => {
    const xml =
      '<beans><bean id="job" class="org.springframework.scheduling.quartz.JobDetailFactoryBean">' +
      '<property name="jobClass" value="com.example.job.SyncJob"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('promotes "targetClass" the same way', () => {
    const xml =
      '<beans><bean id="proxy" class="com.example.ProxyFactory">' +
      '<property name="targetClass" value="com.example.service.RealService"/>' +
      '</bean></beans>';
    const proxy = beanByName(xml, 'proxy')!;
    const r = refs(xml).filter((x) => x.fromNodeId === proxy.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.service::RealService');
  });

  it('promotes "driverClassName" (the JDBC by-string-configuration shape)', () => {
    const xml =
      '<beans><bean id="ds" class="com.example.pool.PoolingDataSource">' +
      '<property name="driverClassName" value="com.example.jdbc.Driver"/>' +
      '</bean></beans>';
    const ds = beanByName(xml, 'ds')!;
    const r = refs(xml).filter((x) => x.fromNodeId === ds.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.jdbc::Driver');
  });

  it('promotes the <constructor-arg name="…" value="…"> form', () => {
    const xml =
      '<beans><bean id="job" class="com.example.JobHolder">' +
      '<constructor-arg name="jobClass" value="com.example.job.SyncJob"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('promotes the <value>text</value> child-element form (no value= attribute)', () => {
    const xml =
      '<beans><bean id="job" class="org.springframework.scheduling.quartz.JobDetailFactoryBean">' +
      '<property name="jobClass"><value>com.example.job.SyncJob</value></property>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('promotes the p-namespace literal form (p:jobClass="…")', () => {
    const xml = '<beans><bean id="job" class="com.example.JobHolder" p:jobClass="com.example.job.SyncJob"/></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('maps a static-nested-class $ separator via the same javaFqnToQualifiedName mapping', () => {
    const xml =
      '<beans><bean id="job" class="com.example.JobHolder">' +
      '<property name="jobClass" value="com.example.Outer$Inner"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example::Outer::Inner');
  });

  it('promotes a CDATA-wrapped <value> child (<value><![CDATA[...]]></value>)', () => {
    const xml =
      '<beans><bean id="job" class="org.springframework.scheduling.quartz.JobDetailFactoryBean">' +
      '<property name="jobClass"><value><![CDATA[com.example.job.SyncJob]]></value></property>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('promotes the c-namespace literal form (c:jobClass="…")', () => {
    const xml = '<beans><bean id="job" class="com.example.JobHolder" c:jobClass="com.example.job.SyncJob"/></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  it('promotes a p:jobClass literal declared via a non-conventional xmlns prefix', () => {
    const xml =
      '<beans xmlns:pp="http://www.springframework.org/schema/p">' +
      '<bean id="job" class="com.example.JobHolder" pp:jobClass="com.example.job.SyncJob"/></beans>';
    const job = beanByName(xml, 'job')!;
    const r = refs(xml).filter((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates');
    expect(r.map((x) => x.referenceName)).toContain('com.example.job::SyncJob');
  });

  // Every negative below uses a bean WITHOUT its own `class=` attribute
  // (id-only, `parent=`-anchored) so the promotion channel under test is the
  // ONLY possible source of an `instantiates` reference — an unguarded
  // `class="com.example.JobHolder"` on the bean itself would otherwise emit
  // its own headline instantiates ref and mask a promotion bug as a pass.

  it('does NOT promote a ${placeholder} value', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobClass" value="${job.class}"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a single-segment (non-FQN-shaped) value', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobClass" value="SyncJob"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a non-*Class/*ClassName property name, even with an FQN-shaped value', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobDescription" value="com.example.job.SyncJob"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote an all-lowercase "superclass"-shaped name (no camelCase boundary into "Class")', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="superclass" value="com.example.job.SyncJob"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote an empty value', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobClass" value=""/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a lowercase-led final segment (method-shaped, not class-shaped)', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="listenerClass" value="com.example.svc.doWork"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a ${placeholder} value in the <value>-child form', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobClass"><value>${job.class}</value></property>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a ${placeholder} value in the p-namespace literal form', () => {
    const xml = '<beans><bean id="job" parent="jobBase" p:jobClass="${job.class}"/></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
  });

  it('does NOT promote a p:jobClass-ref attribute (bean reference, not a by-value class literal)', () => {
    const xml = '<beans><bean id="job" parent="jobBase" p:jobClass-ref="someBean"/></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
    // It's still picked up on the ordinary references channel, not dropped entirely.
    expect(refsFrom(xml, job.id).map((r) => r.referenceName)).toContain('someBean');
  });

  it('does NOT promote a <property name="jobClass" ref="…"/> (bean reference, not a by-value class literal)', () => {
    const xml =
      '<beans><bean id="job" parent="jobBase">' +
      '<property name="jobClass" ref="someBean"/>' +
      '</bean></beans>';
    const job = beanByName(xml, 'job')!;
    expect(refs(xml).some((x) => x.fromNodeId === job.id && x.referenceKind === 'instantiates')).toBe(false);
    expect(refsFrom(xml, job.id).map((r) => r.referenceName)).toContain('someBean');
  });
});

describe('Spring beans extractor — <alias>', () => {
  it('emits a resolvable alias node with a references edge to the target bean name', () => {
    const xml = '<beans><bean id="fooService" class="com.example.Foo"/><alias name="fooService" alias="foo"/></beans>';
    const aliasNode = beanByName(xml, 'foo');
    expect(aliasNode).toBeDefined();
    expect(aliasNode!.qualifiedName).toBe('foo');
    const r = refs(xml).find((x) => x.fromNodeId === aliasNode!.id && x.referenceKind === 'references');
    expect(r?.referenceName).toBe('fooService');
  });

  it('drops a malformed <alias> missing name or alias without emitting a node', () => {
    const xml = '<beans><alias alias="onlyAlias"/><alias name="onlyName"/></beans>';
    expect(beanNodes(xml)).toHaveLength(0);
  });
});

describe('Spring beans extractor — <import>', () => {
  it('strips the classpath: prefix so a no-slash resource resolves by basename', () => {
    const xml = '<beans><import resource="classpath:other-context.xml"/></beans>';
    const r = result(xml);
    const fileNode = r.nodes.find((n) => n.kind === 'file')!;
    const imp = r.unresolvedReferences.find((x) => x.referenceKind === 'imports');
    expect(imp).toBeDefined();
    expect(imp!.fromNodeId).toBe(fileNode.id);
    expect(imp!.referenceName).toBe('other-context.xml');
  });

  it('strips classpath*: and file: prefixes too, preserving a subdirectory path', () => {
    const xml =
      '<beans><import resource="classpath*:context/common.xml"/>' +
      '<import resource="file:/etc/app/extra.xml"/></beans>';
    const names = result(xml).unresolvedReferences.filter((x) => x.referenceKind === 'imports').map((x) => x.referenceName);
    expect(names).toEqual(expect.arrayContaining(['context/common.xml', '/etc/app/extra.xml']));
  });
});

describe('Spring beans extractor — id-bearing NamespacedElements (jee/util)', () => {
  const xml =
    '<beans xmlns:jee="http://www.springframework.org/schema/jee" xmlns:util="http://www.springframework.org/schema/util">' +
    '<jee:jndi-lookup id="dataSource" jndi-name="java:comp/env/jdbc/MyDB"/>' +
    '<util:list id="triggers"><ref bean="cronTrigger"/></util:list>' +
    '<bean id="repo" class="com.example.Repo"><property name="dataSource" ref="dataSource"/></bean>' +
    '</beans>';

  it('emits a bean-like node for <jee:jndi-lookup id=…> so ref="dataSource" resolves', () => {
    const dataSource = beanByName(xml, 'dataSource');
    expect(dataSource).toBeDefined();
    const repo = beanByName(xml, 'repo')!;
    expect(refsFrom(xml, repo.id).map((r) => r.referenceName)).toContain('dataSource');
  });

  it('emits a bean-like node for <util:list id=…>', () => {
    expect(beanByName(xml, 'triggers')).toBeDefined();
  });

  it('does NOT recurse into a NamespacedElement\'s contents for refs (documented v1 blind spot)', () => {
    const triggers = beanByName(xml, 'triggers')!;
    expect(refsFrom(xml, triggers.id)).toHaveLength(0);
  });
});

describe('Spring beans extractor — leniency (shared contract with MyBatis)', () => {
  it('does not emit a node for a commented-out <bean>', () => {
    const xml = '<beans><!-- <bean id="dead" class="com.example.Dead"/> --><bean id="live" class="com.example.Live"/></beans>';
    expect(beanByName(xml, 'dead')).toBeUndefined();
    expect(beanByName(xml, 'live')).toBeDefined();
  });

  it('accepts single-quoted attributes', () => {
    const xml = "<beans><bean id='fooService' class='com.example.Foo'/></beans>";
    expect(beanByName(xml, 'fooService')).toBeDefined();
  });

  it('tolerates whitespace before the closing > of an end tag (</bean >)', () => {
    const xml = '<beans><bean id="a" class="com.example.A"><property name="dep" ref="b"/></bean ></beans>';
    const a = beanByName(xml, 'a');
    expect(a).toBeDefined();
    expect(refsFrom(xml, a!.id).map((r) => r.referenceName)).toContain('b');
  });

  it('never throws on truncated/malformed input — degrades to a file node', () => {
    const xml = '<beans><bean id="a" class="com.example.A"';
    expect(() => result(xml)).not.toThrow();
    const r = result(xml);
    expect(r.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('tolerates a mismatched closing tag without throwing, still extracting the bean before it', () => {
    const xml = '<beans><bean id="a" class="com.example.A"></notbean></beans>';
    expect(() => result(xml)).not.toThrow();
    expect(beanByName(xml, 'a')).toBeDefined();
  });

  it('tolerates a legal > inside a quoted attribute value (SpEL) without truncating the tag or mis-nesting siblings', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A" p:expr="#{x > 3}"/><bean id="b" class="com.example.B"/></beans>';
    const r = result(xml);
    const fileNode = r.nodes.find((n) => n.kind === 'file')!;
    const a = beanByName(xml, 'a');
    const b = beanByName(xml, 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Both are top-level, self-closed beans — both contained by the file,
    // NOT by each other (the bug this pins: a mis-parsed `>` inside the
    // quoted value left bean `a` "open", nesting `b` inside it instead).
    expect(r.edges.some((e) => e.kind === 'contains' && e.source === fileNode.id && e.target === a!.id)).toBe(true);
    expect(r.edges.some((e) => e.kind === 'contains' && e.source === fileNode.id && e.target === b!.id)).toBe(true);
  });

  it('treats <!-- and --> inside CDATA as data, not comment delimiters', () => {
    const xml =
      '<beans><bean id="live" class="com.example.Live">' +
      '<property name="note"><value><![CDATA[<!--not a comment-->]]></value></property>' +
      '</bean></beans>';
    expect(beanByName(xml, 'live')).toBeDefined();
  });
});

describe('Spring beans extractor — negatives', () => {
  it('never emits a reference with an empty name (ref="")', () => {
    const xml =
      '<beans><bean id="a" class="com.example.A">' +
      '<property name="dep" ref=""/>' +
      '<property name="dep2" ref="b"/>' +
      '</bean></beans>';
    const a = beanByName(xml, 'a')!;
    const names = refsFrom(xml, a.id).map((r) => r.referenceName);
    expect(names).toEqual(['b']);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it('leaves ordinary (non-Spring, non-MyBatis) XML untouched by this extractor', () => {
    const xml = '<?xml version="1.0"?><Configuration><Loggers><Root level="info"/></Loggers></Configuration>';
    const r = result(xml, 'log4j.xml');
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.kind).toBe('file');
  });
});

describe('Spring beans extractor — bean→class instantiates edge resolves end-to-end against a real Java node', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('resolves a <bean class="..."> instantiates reference to the actual Java class node, not just a string shape', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-test-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example', 'service');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'FooServiceImpl.java'),
      'package com.example.service;\n\npublic class FooServiceImpl {\n    public FooServiceImpl() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="fooService" class="com.example.service.FooServiceImpl"/></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const fooService = cg.getNodesByKind('variable').find((n) => n.name === 'fooService');
    expect(fooService).toBeDefined();

    const fooServiceImpl = cg.getNodesByKind('class').find((n) => n.name === 'FooServiceImpl');
    expect(fooServiceImpl).toBeDefined();

    const outgoing = cg.getOutgoingEdges(fooService!.id);
    const instantiates = outgoing.find((e) => e.kind === 'instantiates');
    expect(instantiates).toBeDefined();
    expect(instantiates!.target).toBe(fooServiceImpl!.id);
  });

  it('resolves a promoted by-value jobClass property (blind spot ⑶) to the actual Java class node', async () => {
    // Pins the referenceName-shape contract (javaFqnToQualifiedName) between
    // the promoted channel and the resolver — the headline `class=` channel
    // already has this end-to-end coverage above; the promoted channel was
    // previously only asserted at the unresolvedReferences layer.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-jobclass-test-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example', 'job');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'SyncJob.java'),
      'package com.example.job;\n\npublic class SyncJob {\n    public SyncJob() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="job" class="org.springframework.scheduling.quartz.JobDetailFactoryBean">' +
        '<property name="jobClass" value="com.example.job.SyncJob"/>' +
        '</bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const job = cg.getNodesByKind('variable').find((n) => n.name === 'job');
    expect(job).toBeDefined();

    const syncJob = cg.getNodesByKind('class').find((n) => n.name === 'SyncJob');
    expect(syncJob).toBeDefined();

    const outgoing = cg.getOutgoingEdges(job!.id);
    const instantiates = outgoing.find((e) => e.kind === 'instantiates' && e.target === syncJob!.id);
    expect(instantiates).toBeDefined();
  });
});

describe('Spring beans extractor — cross-file bean→bean reference resolves via CodeGraph.init', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('resolves a <property ref="…"> in one XML file to the bean declared in a sibling XML file', async () => {
    // Pins the design note on `emitBean`: qualifiedName is deliberately just
    // the bean name (unscoped by file path), because one ApplicationContext
    // is commonly assembled from many XML files — a ref in file A must
    // resolve to a bean declared in file B, not dangle just because they're
    // different files.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-cross-file-'));
    fs.writeFileSync(
      path.join(tempDir, 'service-context.xml'),
      '<beans><bean id="svc" class="com.example.ServiceImpl">' +
        '<property name="repo" ref="repo"/></bean></beans>\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'repo-context.xml'),
      '<beans><bean id="repo" class="com.example.RepoImpl"/></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const svc = cg.getNodesByKind('variable').find((n) => n.name === 'svc');
    const repo = cg.getNodesByKind('variable').find((n) => n.name === 'repo');
    expect(svc).toBeDefined();
    expect(repo).toBeDefined();
    // The two beans live in different files — repo-context.xml, not
    // service-context.xml — so this only passes if resolution found the
    // cross-file match, not just a same-file one.
    expect(repo!.filePath).toBe('repo-context.xml');
    expect(svc!.filePath).toBe('service-context.xml');

    const outgoing = cg.getOutgoingEdges(svc!.id);
    const referenceEdge = outgoing.find((e) => e.kind === 'references' && e.target === repo!.id);
    expect(referenceEdge).toBeDefined();
  });
});

describe('Spring beans extractor — ANNOTATION-SCANNED BEAN JOIN (v1.1 V3-scanJoin)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('resolves ref="userService" (no matching XML bean) to the Java class annotated @Service, via the decapitalized default bean name', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-default-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'UserService.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="controller" class="com.example.UserController">' +
        '<property name="userService" ref="userService"/></bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const controller = cg.getNodesByKind('variable').find((n) => n.name === 'controller');
    const userService = cg.getNodesByKind('class').find((n) => n.name === 'UserService');
    expect(controller).toBeDefined();
    expect(userService).toBeDefined();

    const outgoing = cg.getOutgoingEdges(controller!.id);
    const referenceEdge = outgoing.find((e) => e.kind === 'references' && e.target === userService!.id);
    expect(referenceEdge).toBeDefined();
    expect(referenceEdge!.metadata?.resolvedBy).toBe('framework');
  });

  it('resolves ref="customName" to the class carrying the matching explicit @Service("customName") value', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-explicit-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'UserService.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service("customName")\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="controller" class="com.example.UserController">' +
        '<property name="userService" ref="customName"/></bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const controller = cg.getNodesByKind('variable').find((n) => n.name === 'controller');
    const userService = cg.getNodesByKind('class').find((n) => n.name === 'UserService');
    expect(controller).toBeDefined();
    expect(userService).toBeDefined();

    const outgoing = cg.getOutgoingEdges(controller!.id);
    const referenceEdge = outgoing.find((e) => e.kind === 'references' && e.target === userService!.id);
    expect(referenceEdge).toBeDefined();
  });

  it('does NOT resolve when two classes derive the same default bean name (ambiguity negative — no edge)', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-ambiguous-'));
    const srcDirA = path.join(tempDir, 'src', 'main', 'java', 'com', 'example', 'a');
    const srcDirB = path.join(tempDir, 'src', 'main', 'java', 'com', 'example', 'b');
    fs.mkdirSync(srcDirA, { recursive: true });
    fs.mkdirSync(srcDirB, { recursive: true });
    fs.writeFileSync(
      path.join(srcDirA, 'UserService.java'),
      'package com.example.a;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(srcDirB, 'UserService.java'),
      'package com.example.b;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="controller" class="com.example.a.UserController">' +
        '<property name="userService" ref="userService"/></bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const controller = cg.getNodesByKind('variable').find((n) => n.name === 'controller');
    expect(controller).toBeDefined();
    const userServiceClasses = cg.getNodesByKind('class').filter((n) => n.name === 'UserService');
    expect(userServiceClasses.length).toBe(2);

    const outgoing = cg.getOutgoingEdges(controller!.id);
    const referenceEdge = outgoing.find(
      (e) => e.kind === 'references' && userServiceClasses.some((c) => c.id === e.target)
    );
    expect(referenceEdge).toBeUndefined();
  });

  it('prefers an XML-declared <bean id="userService"> over the same-named @Service class (join stands down)', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-xmlwins-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'UserService.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans>' +
        '<bean id="userService" class="com.example.UserServiceImpl"/>' +
        '<bean id="controller" class="com.example.UserController">' +
        '<property name="userService" ref="userService"/></bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const controller = cg.getNodesByKind('variable').find((n) => n.name === 'controller');
    const declaredBean = cg.getNodesByKind('variable').find((n) => n.name === 'userService');
    const annotatedClass = cg.getNodesByKind('class').find((n) => n.name === 'UserService');
    expect(controller).toBeDefined();
    expect(declaredBean).toBeDefined();
    expect(annotatedClass).toBeDefined();

    const outgoing = cg.getOutgoingEdges(controller!.id);
    const toDeclaredBean = outgoing.find((e) => e.kind === 'references' && e.target === declaredBean!.id);
    const toAnnotatedClass = outgoing.find((e) => e.kind === 'references' && e.target === annotatedClass!.id);
    // The explicit XML bean definition wins — Spring semantics say an
    // explicit `<bean id>` overrides a scanned component with the same name.
    expect(toDeclaredBean).toBeDefined();
    expect(toAnnotatedClass).toBeUndefined();
  });

  it('prefers a profile-split XML-declared bean (2 files declaring id="userService") over the @Service class', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-profilesplit-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'UserService.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'app-dev.xml'),
      '<beans><bean id="userService" class="com.example.DevUserServiceImpl"/></beans>\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'app-prod.xml'),
      '<beans><bean id="userService" class="com.example.ProdUserServiceImpl"/></beans>\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'applicationContext.xml'),
      '<beans><bean id="controller" class="com.example.UserController">' +
        '<property name="userService" ref="userService"/></bean></beans>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const controller = cg.getNodesByKind('variable').find((n) => n.name === 'controller');
    const declaredBeans = cg.getNodesByKind('variable').filter((n) => n.name === 'userService');
    const annotatedClass = cg.getNodesByKind('class').find((n) => n.name === 'UserService');
    expect(controller).toBeDefined();
    expect(declaredBeans.length).toBe(2);
    expect(annotatedClass).toBeDefined();

    const outgoing = cg.getOutgoingEdges(controller!.id);
    const toAnnotatedClass = outgoing.find((e) => e.kind === 'references' && e.target === annotatedClass!.id);
    // The join must stand down even when several XML files declare the same
    // id — an explicit (if ambiguous) XML bean definition still outranks the
    // scanned component guess.
    expect(toAnnotatedClass).toBeUndefined();
  });

  it('does NOT let the XML-bean-join name-shape claim hijack an unrelated dangling camelCase call ref via fuzzy matching', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-noleak-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    // Present so springResolver.detect() fires (project-level Spring detection).
    fs.writeFileSync(
      path.join(srcDir, 'UserService.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class UserService {\n    public UserService() {}\n}\n'
    );
    // Calls an external, undeclared parseJSON() — dangling by construction,
    // and shaped like a decapitalized multi-word name (camelCase with an
    // internal capital) so it matches XML_BEAN_JOIN_NAME_SHAPE_RE.
    fs.writeFileSync(
      path.join(srcDir, 'Caller.java'),
      'package com.example;\n\n' +
        'public class Caller {\n' +
        '    public void run() {\n' +
        '        parseJSON();\n' +
        '    }\n' +
        '}\n'
    );
    // An unrelated same-shaped (case-insensitive near-miss) method that
    // `matchFuzzy` could wrongly latch onto if the shape-only claim leaked
    // this ref into the full resolution pipeline.
    fs.writeFileSync(
      path.join(srcDir, 'JsonUtil.java'),
      'package com.example;\n\n' +
        'public class JsonUtil {\n' +
        '    public static void parseJson() {}\n' +
        '}\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const runMethod = cg.getNodesByKind('method').find((n) => n.name === 'run');
    const parseJson = cg.getNodesByKind('method').find((n) => n.name === 'parseJson');
    expect(runMethod).toBeDefined();
    expect(parseJson).toBeDefined();

    const outgoing = cg.getOutgoingEdges(runMethod!.id);
    const wrongFuzzyEdge = outgoing.find((e) => e.kind === 'calls' && e.target === parseJson!.id);
    expect(wrongFuzzyEdge).toBeUndefined();
  });

  it('does NOT apply the join to a genuinely-dangling MyBatis <include refid> ref, even when it name-shape-matches a @Service bean name', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-spring-beans-scanjoin-mybatis-negative-'));
    const srcDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'ParseUserJson.java'),
      'package com.example;\n\n' +
        'import org.springframework.stereotype.Service;\n\n' +
        '@Service\npublic class ParseUserJson {\n    public ParseUserJson() {}\n}\n'
    );
    // A namespace-less iBatis 2 <sqlMap> mapper (namespace optional per the
    // extractor's own routing) so the <include refid> resolves to a bare,
    // unqualified name — landing squarely on XML_BEAN_JOIN_NAME_SHAPE_RE's
    // shape ("parseUserJson", decapitalized-multi-word) while its SOURCE
    // node is a MyBatis statement (`kind: 'method'`), not a Spring bean
    // (`kind: 'variable'`) — the exact channel `isXmlBeanJoinSourceRef` must
    // reject. No `<sql id="parseUserJson">` fragment exists in this mapper —
    // the refid is genuinely dangling (no legitimate same-name candidate),
    // so this isolates whether the framework join (or a fuzzy hijack let
    // through by its `claimsReference` pre-filter escape) wrongly resolves
    // it, rather than a legitimate exact/qualified-name match masking it.
    fs.writeFileSync(
      path.join(tempDir, 'UserMapper.xml'),
      '<sqlMap>' +
        '<select id="getUser"><include refid="parseUserJson"/>SELECT * FROM users</select>' +
        '</sqlMap>\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const getUser = cg.getNodesByKind('method').find((n) => n.name === 'getUser');
    const annotatedClass = cg.getNodesByKind('class').find((n) => n.name === 'ParseUserJson');
    expect(getUser).toBeDefined();
    expect(annotatedClass).toBeDefined();

    const outgoing = cg.getOutgoingEdges(getUser!.id);
    const wrongEdge = outgoing.find((e) => e.target === annotatedClass!.id);
    expect(wrongEdge).toBeUndefined();
  });
});
