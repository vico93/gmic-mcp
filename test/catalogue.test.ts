import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCatalogue, searchCatalogue, stripAnsi } from '../src/gmic/catalogue.js';

const source = `#@cli :: Filters
#@cli blur : sigma,_boundary \\
# _kernel
#@cli : Blur selected images. \\
# Preserves their dimensions.
#@cli :
#@cli : Default values: 'sigma=1'.
blur : fake-code-that-must-never-execute
#@cli b : eq. to 'blur'.
#@cli :: Geometry
#@cli resize : width,height
#@cli : Resize images.
`;

describe('native documentation catalogue', () => {
  it('parses categories, argument continuations, aliases, and descriptions as data', () => {
    const docs = parseCatalogue(source);
    assert.equal(docs.length, 3);
    const blur = docs.find((doc) => doc.name === 'blur')!;
    assert.equal(blur.category, 'Filters');
    assert.equal(blur.arguments, 'sigma,_boundary  _kernel');
    assert.match(blur.description, /Blur selected images\. Preserves their dimensions/);
    assert.doesNotMatch(blur.documentation, /fake-code/);
  });

  it('ranks command names and supports multiword/category searches', () => {
    const docs = parseCatalogue(source);
    assert.equal(searchCatalogue(docs, 'blur')[0]?.name, 'blur');
    assert.equal(searchCatalogue(docs, 'blur dimensions').length, 1);
    assert.equal(searchCatalogue(docs, '', 'geometry')[0]?.name, 'resize');
    assert.equal(searchCatalogue(docs, 'nothing').length, 0);
  });

  it('removes console color codes', () => {
    assert.equal(stripAnsi('\u001b[31mblur\u001b[0m'), 'blur');
  });
});
