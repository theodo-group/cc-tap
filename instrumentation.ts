// Runs once at server startup (before any request is handled). We use it to
// seed a fictional dataset on hosted deploys so the dashboard isn't empty —
// see lib/demo-data.ts. Only the Node.js runtime can touch the filesystem.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setupDemoData } = await import('./lib/demo-data')
    setupDemoData()
  }
}
