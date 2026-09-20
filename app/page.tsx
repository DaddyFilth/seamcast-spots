'use client';

import Link from 'next/link';

export default function HomePage() {
  return (
    <main
      style={{
        padding: '2rem',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont',
        backgroundColor: '#020617',
        color: '#e5e7eb',
        minHeight: '100vh',
      }}
    >
      <h1
        style={{
          fontSize: '1.75rem',
          marginBottom: '0.75rem',
        }}
      >
        Seamcast-Spots
      </h1>
      <p
        style={{
          fontSize: '0.95rem',
          color: '#9ca3af',
          marginBottom: '1.5rem',
        }}
      >
        This service powers AI fishing spot forecasts for Seamcast.
      </p>

      <Link
        href="/health"
        style={{
          display: 'inline-block',
          padding: '0.5rem 1rem',
          borderRadius: '0.375rem',
          backgroundColor: '#22c55e',
          color: '#022c22',
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        View API Health
      </Link>
    </main>
  );
}
