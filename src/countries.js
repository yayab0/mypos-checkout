'use strict';
// ISO 3166-1: alpha-2 -> [alpha-3, name]. Shopify uses alpha-2, myPOS expects alpha-3.
const COUNTRIES = {
  GB: ['GBR', 'United Kingdom'], IE: ['IRL', 'Ireland'], FR: ['FRA', 'France'], DE: ['DEU', 'Germany'],
  ES: ['ESP', 'Spain'], IT: ['ITA', 'Italy'], NL: ['NLD', 'Netherlands'], BE: ['BEL', 'Belgium'],
  CH: ['CHE', 'Switzerland'], AT: ['AUT', 'Austria'], PT: ['PRT', 'Portugal'], SE: ['SWE', 'Sweden'],
  DK: ['DNK', 'Denmark'], NO: ['NOR', 'Norway'], FI: ['FIN', 'Finland'], PL: ['POL', 'Poland'],
  CZ: ['CZE', 'Czechia'], SK: ['SVK', 'Slovakia'], HU: ['HUN', 'Hungary'], RO: ['ROU', 'Romania'],
  BG: ['BGR', 'Bulgaria'], GR: ['GRC', 'Greece'], HR: ['HRV', 'Croatia'], SI: ['SVN', 'Slovenia'],
  LT: ['LTU', 'Lithuania'], LV: ['LVA', 'Latvia'], EE: ['EST', 'Estonia'], LU: ['LUX', 'Luxembourg'],
  MT: ['MLT', 'Malta'], CY: ['CYP', 'Cyprus'], IS: ['ISL', 'Iceland'], LI: ['LIE', 'Liechtenstein'],
  MC: ['MCO', 'Monaco'], US: ['USA', 'United States'], CA: ['CAN', 'Canada'], AU: ['AUS', 'Australia'],
  NZ: ['NZL', 'New Zealand'], MA: ['MAR', 'Morocco'], AE: ['ARE', 'United Arab Emirates'],
  SA: ['SAU', 'Saudi Arabia'], TR: ['TUR', 'Türkiye'], IL: ['ISR', 'Israel'], ZA: ['ZAF', 'South Africa'],
  JP: ['JPN', 'Japan'], SG: ['SGP', 'Singapore'], HK: ['HKG', 'Hong Kong'], IN: ['IND', 'India'],
  BR: ['BRA', 'Brazil'], MX: ['MEX', 'Mexico'], RS: ['SRB', 'Serbia'], UA: ['UKR', 'Ukraine'],
};
const alpha3 = (a2) => (COUNTRIES[String(a2).toUpperCase()] || COUNTRIES.GB)[0];
const isKnown = (a2) => !!COUNTRIES[String(a2).toUpperCase()];
const options = (selected = 'GB') => Object.entries(COUNTRIES)
  .sort((a, b) => (a[0] === 'GB' ? -1 : b[0] === 'GB' ? 1 : a[1][1].localeCompare(b[1][1])))
  .map(([a2, [, name]]) => `<option value="${a2}"${a2 === selected ? ' selected' : ''}>${name}</option>`).join('');
module.exports = { COUNTRIES, alpha3, isKnown, options };
