// Credentials are supplied by the existing Vercel integration and never printed or exported.
if (process.env.VERCEL_ENV === 'production') await import('./migrate.mjs');
else console.log('Production database migration not required in this environment.');
