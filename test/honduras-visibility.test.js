const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
const sar = fs.readFileSync(path.join(root, 'src/routes/sar.js'), 'utf8');

test('Facturación Honduras se reserva para dueños registrados en HN con lada +504', () => {
  const predicate = app.match(/function isHondurasTenant\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(predicate);
  const eligible = (phoneCountry, phoneCallingCode, demoSession = false) => vm.runInNewContext(`${predicate}; isHondurasTenant()`, {
    ME: { tenant: { phoneCountry, phoneCallingCode }, demoSession },
  });
  assert.equal(eligible('HN', '504'), true);
  assert.equal(eligible('MX', '52'), false);
  assert.equal(eligible('HN', '52'), false);
  assert.equal(eligible('HN', '504', true), false);
  assert.match(app, /const hondurasAllowed = a\.dataset\.hondurasOnly !== 'true' \|\| \(isHondurasTenant\(\) && ME\?\.role === 'owner'\)/);
  assert.match(app, /\[data-owner-only\]:not\(\.sidebar nav a\)/);
  assert.match(html, /data-view="sar"[^>]+data-honduras-only="true"[^>]+hidden/);
  assert.match(sar, /req\.user\.demoLeadId \|\| req\.tenant\.phone_country !== 'HN' \|\| \(callingCode && callingCode !== '504'\)/);
});
