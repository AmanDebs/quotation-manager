import './helpers/scratch.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { incoBasis } from '../src/services/pdf.js';

/**
 * Which place a delivery basis names (2026-10-16, the client with a proforma
 * in front of them: *"FOB – still taking destination port name (linked with
 * port of discharge), it should not take"*).
 *
 * This is a **commercial** rule rather than a formatting one, which is why it
 * is worth cases: under Incoterms the place after FOB is the port the goods
 * are shipped *from*, and the destination belongs to CIF, CFR and the
 * D-terms. Four builders were composing `${inco} ${port_of_discharge}`
 * regardless, so a proforma read *FOB Kolkata Port HOWRAH* — a loading port
 * and a discharge port on one line, with a buyer free to take either as the
 * basis.
 */

const PORTS = { loading: 'Nhava Sheva Port', discharge: 'Nacala, Mozambique' };

describe('the place a delivery basis names', () => {
  test('FOB takes the port of shipment, never the destination', () => {
    assert.equal(incoBasis('FOB', PORTS), 'FOB NHAVA SHEVA PORT');
    assert.equal(incoBasis('FAS', PORTS), 'FAS NHAVA SHEVA PORT');
  });

  test('CIF and the D-terms take the destination', () => {
    // The first comma-separated segment, the rule the shipping marks follow:
    // "Nacala, Mozambique" is a port called Nacala.
    assert.equal(incoBasis('CIF', PORTS), 'CIF NACALA');
    assert.equal(incoBasis('CFR', PORTS), 'CFR NACALA');
    assert.equal(incoBasis('DDP', PORTS), 'DDP NACALA');
    assert.equal(incoBasis('CPT', PORTS), 'CPT NACALA');
  });

  /**
   * The case the client reported. Their own INCO list offers *FOB Kolkata
   * Port* and *FOB Nhava Sheva Port*, so the commonest export basis on this
   * book already names its port — and appending the destination to it is what
   * printed the line in the screenshot.
   */
  test('a basis that already names a place is printed as it stands', () => {
    assert.equal(incoBasis('FOB Kolkata Port', PORTS), 'FOB Kolkata Port');
    assert.equal(incoBasis('FOB Nhava Sheva Port', PORTS), 'FOB Nhava Sheva Port');
    assert.equal(incoBasis('FOB India', PORTS), 'FOB India');
    // The same fault one term over: real Aglo documents carry CIF Mozambique,
    // and the old composition would have made it "CIF Mozambique NACALA".
    assert.equal(incoBasis('CIF Mozambique', PORTS), 'CIF Mozambique');
  });

  test('a term whose place is neither port is left alone', () => {
    // EXW names a seller's premises and FCA any agreed point, so standing a
    // port in for either would state something the document does not say.
    assert.equal(incoBasis('EX-Works', PORTS), 'EX-Works');
    assert.equal(incoBasis('EXW', PORTS), 'EXW');
    assert.equal(incoBasis('FCA', PORTS), 'FCA');
    // The domestic list's own two, which name no port at all.
    assert.equal(incoBasis('FOR', PORTS), 'FOR');
    assert.equal(incoBasis('EX-KOLKATA', PORTS), 'EX-KOLKATA');
  });

  test('a port the document does not state appends nothing', () => {
    assert.equal(incoBasis('FOB', { discharge: 'Nacala' }), 'FOB', 'no loading port to name');
    assert.equal(incoBasis('CIF', { loading: 'Nhava Sheva' }), 'CIF', 'no discharge port to name');
    assert.equal(incoBasis('FOB', {}), 'FOB');
    assert.equal(incoBasis('CIF', { discharge: '   ' }), 'CIF', 'whitespace is not a port');
  });

  test('no basis is no label', () => {
    assert.equal(incoBasis('', PORTS), '');
    assert.equal(incoBasis(null, PORTS), '');
    assert.equal(incoBasis(undefined, PORTS), '');
    assert.equal(incoBasis('   ', PORTS), '');
  });

  test('the code is matched however it is cased', () => {
    assert.equal(incoBasis('fob', PORTS), 'fob NHAVA SHEVA PORT');
    assert.equal(incoBasis('cif', PORTS), 'cif NACALA');
  });
});
