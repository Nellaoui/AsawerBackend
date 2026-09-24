const express = require('express');
const http = require('http');
const portalRoutes = require('../portalRoutes');

describe('public operations portal pages', () => {
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/admin', portalRoutes);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error: Error) => error ? reject(error) : resolve()));
  });

  test('serves the workflow page and disables caching', async () => {
    const response = await fetch(`${baseUrl}/admin/workflow`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Asawer');
    expect(html).toContain('id="imageViewer"');
    expect(html).toContain('id="zoomInImage"');
    expect(html).toContain('data-zoom-image');
    expect(html).toContain("location.replace(SOCKET_ORIGIN+'/admin/workflow'+location.hash)");
    expect(html).toContain("location.origin!==SOCKET_ORIGIN");
    expect(html).toContain("/admin/inventory-embed?embedded=1");
  });

  test('serves the embedded product management page', async () => {
    const response = await fetch(`${baseUrl}/admin/inventory-embed?embedded=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Asawer Stock Portal');
  });

  test('sends direct product-page visits back to the single portal', async () => {
    const response = await fetch(`${baseUrl}/admin/inventory-embed`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/workflow');
  });

  test('redirects the older inventory URL to the unified portal', async () => {
    const response = await fetch(`${baseUrl}/admin/manage-inventory`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/workflow');
  });
});
