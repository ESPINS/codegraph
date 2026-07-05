import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';

// Robustness of the MyBatis mapper extractor against two shapes the regex
// scanner previously mishandled: single-quoted attribute values, and tags
// that live inside XML comments.
describe('MyBatis extractor — attribute quoting', () => {
  const methodNames = (xml: string) =>
    extractFromSource('FooMapper.xml', xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.qualifiedName);

  it('accepts a single-quoted namespace', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      '<select id="getById">SELECT 1</select></mapper>';
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });

  it('accepts a single-quoted statement id', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      "<select id='getById'>SELECT 1</select></mapper>";
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });

  it('accepts a single-quoted <include refid>', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<sql id="cols">id, name</sql>' +
      "<select id='getById'>SELECT <include refid='cols'/> FROM t</select>" +
      '</mapper>';
    const refs = extractFromSource('FooMapper.xml', xml).unresolvedReferences.map(
      (r) => r.referenceName
    );
    expect(refs).toContain('com.example.FooMapper::cols');
  });

  it('handles mixed single- and double-quoted attributes in one file', () => {
    const xml =
      "<mapper namespace='com.example.FooMapper'>" +
      "<select id='getById' resultType='User'>SELECT 1</select>" +
      '<update id="touch" parameterType="User">UPDATE t SET x=1</update>' +
      '</mapper>';
    expect(methodNames(xml)).toEqual([
      'com.example.FooMapper::getById',
      'com.example.FooMapper::touch',
    ]);
  });

  it('still accepts double-quoted attributes (regression guard)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT 1</select></mapper>';
    expect(methodNames(xml)).toContain('com.example.FooMapper::getById');
  });
});

describe('MyBatis extractor — XML comments', () => {
  const result = (xml: string) => extractFromSource('FooMapper.xml', xml);

  it('does not emit a node for a statement inside a comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<!-- <select id="dead">SELECT 1</select> -->' +
      '<select id="live">SELECT 2</select></mapper>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('live');
    expect(names).not.toContain('dead');
  });

  it('does not follow an <include> inside a comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT 1 <!-- <include refid="cols"/> --></select>' +
      '</mapper>';
    const refs = result(xml).unresolvedReferences.map((r) => r.referenceName);
    expect(refs).not.toContain('com.example.FooMapper::cols');
  });

  it('keeps the correct startLine for a statement after a multi-line comment', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">\n' +
      '<!--\n' +
      '  a commented-out block\n' +
      '  spanning several lines\n' +
      '-->\n' +
      '<select id="getById">SELECT 1</select>\n' +
      '</mapper>\n';
    const stmt = result(xml).nodes.find((n) => n.name === 'getById');
    expect(stmt).toBeDefined();
    // The <select> is on the 6th line of the document.
    expect(stmt!.startLine).toBe(6);
  });

  it('treats <!-- and --> inside CDATA as data, not comment delimiters', () => {
    // A commented-looking sequence split across two CDATA sections must not
    // blank the real statement between them — guards the CDATA-skip branch.
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<![CDATA[<!--]]>' +
      '<select id="live">SELECT 1</select>' +
      '<![CDATA[-->]]>' +
      '</mapper>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('live');
  });

  it('does not crash on an unterminated comment (blanks to end of file)', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="before">SELECT 1</select>' +
      '<!-- unterminated, swallowing a <select id="after">SELECT 2</select>';
    const names = result(xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.name);
    expect(names).toContain('before');
    expect(names).not.toContain('after');
  });
});
