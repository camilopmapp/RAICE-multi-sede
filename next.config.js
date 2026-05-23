/** @type {import('next').NextConfig} */
module.exports = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',           value: 'DENY' },
          { key: 'X-Content-Type-Options',     value: 'nosniff' },
          { key: 'Referrer-Policy',            value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',         value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security',  value: 'max-age=63072000; includeSubDomains' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https:",
              "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://*.supabase.co wss://*.supabase.co",
              "frame-ancestors 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ]
  },

  async rewrites() {
    return [
      { source: '/',           destination: '/login.html' },
      { source: '/login',      destination: '/login.html' },
      { source: '/admin',      destination: '/admin.html' },
      { source: '/docente',    destination: '/docente.html' },
      { source: '/superadmin', destination: '/superadmin.html' },
      { source: '/rector',     destination: '/rector.html' },
      { source: '/acudiente',         destination: '/acudiente.html' },
      { source: '/portal-acudiente', destination: '/portal-acudiente.html' },
      { source: '/offline',          destination: '/offline.html' },
    ]
  },
}
