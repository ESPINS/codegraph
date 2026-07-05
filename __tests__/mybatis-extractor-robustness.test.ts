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
