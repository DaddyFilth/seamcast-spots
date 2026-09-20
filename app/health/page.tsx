'use client';

import { useEffect, useState } from 'react';

type Status = 'idle' | 'ok' | 'error';

function StatusBadge({ status }: { status: Status }) {
  const color =
    status === 'ok'
      ? '#16a34a'
      : status === 'error'
      ? '#dc2626'
      : '#6b7280';

  const label =
    status === 'ok'
      ? 'OK'
      : status === 'error'
      ? 'Error'
      : 'Checking…';

  return (
    <span
      style={{
        padding: '0.25rem 0.5rem',
        borderRadius: '9999px',
        backgroundColor: color,
        color: '#fff',
        fontSize: '0.75rem',
      }}
    >
      {label}
    </span>
  );
}

export default function HealthPage() {
  const [apiStatus, setApiStatus] = useState<Status>('idle');
  const [seamcastStatus, setSeamcastStatus] = useState<Status>('idle');
  const [apiDetails, setApiDetails] = useState<string>('');

  useEffect(() => {
    const check = async () => {
      // Check Seamcast-Spots API on this deployment
      try {
        const res = await fetch(
          '/api/spots?lat=34.999&lon=-97.366',
        );
        if (!res.ok) {
          throw new Error(`API responded with ${res.status}`);
        }
        const json = await res.json();
        setApiStatus('ok');
        setApiDetails(JSON.stringify(json, null, 2));
      } catch (err: any) {
        setApiStatus('error');
        setApiDetails(
          err?.message
            ? String(err.message)
            : 'Unknown error contacting /api/spots',
        );
      }

      // Check main Seamcast app reachability
      try {
        await fetch('https://fishfinder-pro.online/', {
          mode: 'no-cors',
        });
        // If fetch doesn't throw, domain is reachable
        setSeamcastStatus('ok');
      } catch {
        setSeamcastStatus('error');
      }
    };

    check();
  }, []);

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
          fontSize: '1.5rem',
          marginBottom: '1rem',
        }}
      >
        Seamcast-Spots Health
      </h1>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2
          style={{
            fontSize: '1.1rem',
            marginBottom: '0.5rem',
          }}
        >
          Spots API
        </h2>
        <StatusBadge status={apiStatus} />
        <p
          style={{
            marginTop: '0.5rem',
            fontSize: '0.9rem',
            color: '#9ca3af',
          }}
        >
          Checks{' '}
          <code>/api/spots?lat=34.999&lon=-97.366</code> on this
          deployment.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2
          style={{
            fontSize: '1.1rem',
            marginBottom: '0.5rem',
          }}
        >
          Seamcast App Connectivity
        </h2>
        <StatusBadge status={seamcastStatus} />
        <p
          style={{
            marginTop: '0.5rem',
            fontSize: '0.9rem',
            color: '#9ca3af',
          }}
        >
          Attempts to reach{' '}
          <code>https://fishfinder-pro.online/</code>.
        </p>
      </section>

      <section>
        <h2
          style={{
            fontSize: '1.1rem',
            marginBottom: '0.5rem',
          }}
        >
          Spots API Details
        </h2>
        <pre
          style={{
            backgroundColor: '#0b1120',
            padding: '1rem',
            borderRadius: '0.5rem',
            fontSize: '0.8rem',
            overflowX: 'auto',
            maxHeight: '20rem',
          }}
        >
          {apiDetails || 'Waiting for response...'}
        </pre>
      </section>
    </main>
  );
}
