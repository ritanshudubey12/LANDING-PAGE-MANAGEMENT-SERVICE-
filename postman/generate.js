// Generates the Postman collection + environment. Run: npm run postman:generate
// The environment file written here contains the real local token and is git-ignored. Do not share it.
const fs = require('node:fs');
const path = require('node:path');

// Secrets come from the git-ignored .env; the collection never contains them.
function readEnv() {
  const file = path.join(__dirname, '..', '.env');
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}
const secrets = readEnv();
if (!secrets.INTERNAL_SERVICE_TOKEN) {
  console.error('INTERNAL_SERVICE_TOKEN missing: create .env (see .env.example) first.');
  process.exit(1);
}

const ctxHeaders = [
  { key: 'Authorization', value: 'Bearer {{token}}' },
  { key: 'X-Tenant-Id', value: '{{tenantId}}' },
  { key: 'X-Organization-Id', value: '{{organizationId}}' },
  { key: 'X-Software-Id', value: '{{softwareId}}' },
  { key: 'X-User-Id', value: '{{userId}}' },
  { key: 'X-Request-Id', value: 'req_postman_{{$timestamp}}' },
  { key: 'X-Permissions', value: '{{permissions}}' },
  { key: 'Accept', value: 'application/json' },
];

const common200 = [
  "pm.test('Status is 200 OK', () => pm.response.to.have.status(200));",
  "const body = pm.response.json();",
  "pm.test('success is true', () => pm.expect(body.success).to.eql(true));",
  "pm.test('requestId is present', () => pm.expect(body.requestId).to.be.a('string').and.not.empty);",
];

function req({ name, method, url, headers = [], body, pre = [], tests = [], auth = true }) {
  const r = {
    name,
    event: [
      ...(pre.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
      { listen: 'test', script: { type: 'text/javascript', exec: [...common200, ...tests] } },
    ],
    request: {
      method,
      header: [...(auth ? ctxHeaders : []), ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []), ...headers],
      url: { raw: '{{baseUrl}}' + url, host: ['{{baseUrl}}'], path: url.replace(/^\//, '').split('?')[0].split('/'),
             ...(url.includes('?') ? { query: url.split('?')[1].split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; }) } : {}) },
      ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
    },
  };
  return r;
}

const items = [
  req({ name: '01 GET /health', method: 'GET', url: '/health', auth: false,
        tests: ["pm.test('status ok', () => pm.expect(body.data.status).to.eql('ok'));"] }),
  req({ name: '02 GET /ready', method: 'GET', url: '/ready', auth: false,
        tests: ["pm.test('dependencies ready', () => pm.expect(body.data.checks).to.eql({ database: true, integrations: true }));"] }),
  req({ name: '03 POST create landing page', method: 'POST', url: '/api/v1/websites/{{websiteId}}/landing-pages',
        headers: [{ key: 'Idempotency-Key', value: '{{createKey}}' }],
        body: { name: 'Spring Campaign', slug: '{{slug}}' },
        pre: ["const n = Date.now();", "pm.collectionVariables.set('slug', 'spring-' + n);", "pm.collectionVariables.set('createKey', 'create-' + n);"],
        tests: [
          "pm.collectionVariables.set('pageId', body.data.id);",
          "pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
          "pm.collectionVariables.set('firstCreateBody', JSON.stringify({ name: 'Spring Campaign', slug: pm.collectionVariables.get('slug') }));",
          "pm.test('IDs are strings', () => { pm.expect(body.data.id).to.be.a('string'); pm.expect(body.data.websiteId).to.eql(pm.collectionVariables.get('websiteId')); });",
          "pm.test('starts unpublished', () => { pm.expect(body.data.publicationStatus).to.eql('UNPUBLISHED'); pm.expect(body.data.publishedRevisionId).to.eql(null); pm.expect(body.data.lifecycleStatus).to.eql('ACTIVE'); });",
        ] }),
  req({ name: '04 POST create (idempotent replay returns same page)', method: 'POST', url: '/api/v1/websites/{{websiteId}}/landing-pages',
        headers: [{ key: 'Idempotency-Key', value: '{{createKey}}' }],
        body: { name: 'Spring Campaign', slug: '{{slug}}' },
        tests: ["pm.test('same page returned', () => pm.expect(body.data.id).to.eql(pm.collectionVariables.get('pageId')));"] }),
  req({ name: '05 GET list landing pages', method: 'GET', url: '/api/v1/websites/{{websiteId}}/landing-pages?limit=20&sortBy=createdAt&order=desc',
        tests: [
          "pm.test('data is an array containing the new page', () => pm.expect(body.data.map(p => p.id)).to.include(pm.collectionVariables.get('pageId')));",
          "pm.test('pagination meta present', () => pm.expect(body.meta).to.have.property('limit', 20));",
        ] }),
  req({ name: '06 GET list with filters (q, publicationStatus)', method: 'GET',
        url: '/api/v1/websites/{{websiteId}}/landing-pages?limit=5&publicationStatus=UNPUBLISHED&lifecycleStatus=ACTIVE&q=spring',
        tests: ["pm.test('data is an array', () => pm.expect(body.data).to.be.an('array'));"] }),
  req({ name: '07 GET landing page by id', method: 'GET', url: '/api/v1/landing-pages/{{pageId}}',
        tests: [
          "pm.test('id matches', () => pm.expect(body.data.id).to.eql(pm.collectionVariables.get('pageId')));",
          "pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
        ] }),
  req({ name: '08 PATCH rename / change slug (If-Match)', method: 'PATCH', url: '/api/v1/landing-pages/{{pageId}}',
        headers: [{ key: 'If-Match', value: '{{etag}}' }],
        body: { name: 'Spring Sale', slug: '{{slug}}-sale' },
        tests: [
          "pm.test('renamed', () => pm.expect(body.data.name).to.eql('Spring Sale'));",
          "pm.test('still unpublished', () => pm.expect(body.data.publicationStatus).to.eql('UNPUBLISHED'));",
          "pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
        ] }),
  req({ name: '09 PUT replace name and slug (If-Match)', method: 'PUT', url: '/api/v1/landing-pages/{{pageId}}',
        headers: [{ key: 'If-Match', value: '{{etag}}' }],
        body: { name: 'Spring Sale Final', slug: '{{slug}}-final' },
        tests: [
          "pm.test('replaced', () => { pm.expect(body.data.name).to.eql('Spring Sale Final'); pm.expect(body.data.slug).to.eql(pm.collectionVariables.get('slug') + '-final'); });",
          "pm.test('still unpublished', () => pm.expect(body.data.publicationStatus).to.eql('UNPUBLISHED'));",
          "pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
        ] }),
  req({ name: '10 POST duplicate landing page', method: 'POST', url: '/api/v1/landing-pages/{{pageId}}/duplicate',
        headers: [{ key: 'Idempotency-Key', value: 'dup-{{$timestamp}}' }],
        body: { name: 'Spring Campaign - Copy', slug: '{{slug}}-copy' },
        tests: [
          "pm.collectionVariables.set('duplicateId', body.data.id);",
          "pm.test('new independent unpublished page', () => { pm.expect(body.data.id).to.not.eql(pm.collectionVariables.get('pageId')); pm.expect(body.data.publicationStatus).to.eql('UNPUBLISHED'); });",
        ] }),
  req({ name: '11 POST publish', method: 'POST', url: '/api/v1/landing-pages/{{pageId}}/publish',
        headers: [{ key: 'Idempotency-Key', value: 'pub-{{$timestamp}}' }], body: {},
        tests: ["pm.test('published', () => { pm.expect(body.data.publicationStatus).to.eql('PUBLISHED'); pm.expect(body.data.publishedRevisionId).to.be.a('string'); });"] }),
  req({ name: '12 POST unpublish', method: 'POST', url: '/api/v1/landing-pages/{{pageId}}/unpublish',
        headers: [{ key: 'Idempotency-Key', value: 'unpub-{{$timestamp}}' }], body: {},
        tests: ["pm.test('unpublished', () => { pm.expect(body.data.publicationStatus).to.eql('UNPUBLISHED'); pm.expect(body.data.publishedRevisionId).to.eql(null); });"] }),
  req({ name: '13 DELETE duplicate (soft-delete)', method: 'DELETE', url: '/api/v1/landing-pages/{{duplicateId}}',
        tests: ["pm.test('deleted', () => pm.expect(body.data.deleted).to.eql(true));"] }),
  req({ name: '14 DELETE original (soft-delete)', method: 'DELETE', url: '/api/v1/landing-pages/{{pageId}}',
        tests: ["pm.test('deleted', () => pm.expect(body.data.deleted).to.eql(true));"] }),
];

const vars = {
  baseUrl: 'http://localhost:4027',
  token: secrets.INTERNAL_SERVICE_TOKEN,
  tenantId: '1001',
  organizationId: '2001',
  softwareId: '10',
  userId: '5001',
  websiteId: '3001',
  permissions: 'landing-page:create,landing-page:read,landing-page:update,landing-page:duplicate,landing-page:delete,landing-page:publish',
};

const collection = {
  info: {
    name: 'Landing Page Management API',
    description: 'All requests assert HTTP 200 and success=true. Local-development credentials only; do not export real secrets.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: Object.entries(vars).map(([key, value]) => ({ key, value: key === 'token' ? '' : value })), // token lives only in the git-ignored environment file
  item: items,
};

const environment = {
  name: 'Landing Page API - local',
  values: Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true })),
  _postman_variable_scope: 'environment',
};

fs.writeFileSync(path.join(__dirname, 'landing-page-api.postman_collection.json'), JSON.stringify(collection, null, 2));
fs.writeFileSync(path.join(__dirname, 'local.postman_environment.json'), JSON.stringify(environment, null, 2));
console.log(`Wrote collection (${items.length} requests) and environment.`);
