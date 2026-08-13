import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  CREATURES,
  ELEMENTS,
  STRINGS,
  effectiveness,
  generateProblem,
  starters,
} from './src/engine';
import { API_BASE_URL, type BackendStatus, fetchSession } from './src/api';

/**
 * The shell.
 *
 * Deliberately not a literal "hello world": it exercises the two things that
 * actually carry risk on a new platform. First, that the shared game engine
 * resolves and runs under Metro and Hermes - the roster, the seeded maths
 * generator and the element wheel are all read live below. Second, that the
 * device can reach the same backend the web client uses.
 *
 * If this screen renders, the platform is proven and the game UI is the only
 * thing left to build.
 */
export default function App() {
  const [status, setStatus] = useState<BackendStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSession().then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read straight from the shared engine so a broken import fails visibly.
  const roster = CREATURES.length;
  const firstPartner = starters()[0]!;
  const problem = generateProblem('mathmon-ios-shell', 4);
  // Every element's multipliers across the whole wheel sum to exactly 7, which
  // is the property that makes no element secretly the best one.
  const wheelIsBalanced = ELEMENTS.every(
    (element) => ELEMENTS.reduce((sum, other) => sum + effectiveness(element, other), 0) === 7,
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>iOS client</Text>
        <Text style={styles.title}>{STRINGS.appName.en}</Text>
        <Text style={styles.subtitle}>{STRINGS.appName.zh}</Text>

        <Section title="Shared game engine">
          <Row label="Creatures loaded" value={String(roster)} ok={roster === 18} />
          <Row
            label="First starter"
            value={`${firstPartner.name.en} · ${firstPartner.name.zh}`}
            ok={firstPartner.stage === 1}
          />
          <Row label="Generated question" value={problem.prompt} ok={problem.answer >= 0} />
          <Row
            label="Element wheel balanced"
            value={wheelIsBalanced ? 'yes' : 'no'}
            ok={wheelIsBalanced}
          />
        </Section>

        <Section title="Backend">
          {status === null ? (
            <ActivityIndicator color="#fbbf24" />
          ) : status.kind === 'not-configured' ? (
            <Row label="API" value="local-only (no URL set)" ok />
          ) : status.kind === 'reachable' ? (
            <>
              <Row label="API" value={API_BASE_URL} ok />
              <Row
                label="Accounts"
                value={status.session.accountsAvailable ? 'available' : 'local-only'}
                ok
              />
            </>
          ) : (
            <Row label="API" value={status.reason} ok={false} />
          )}
        </Section>

        <Text style={styles.footer}>
          Engine and backend shared with the web client. Game UI comes next.
        </Text>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, { color: ok ? '#34d399' : '#fb7185' }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1120' },
  content: { padding: 20, paddingTop: 72, gap: 14 },
  eyebrow: { color: '#64748b', fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: '#ffffff', fontSize: 30, fontWeight: '900' },
  subtitle: { color: '#94a3b8', fontSize: 17, marginBottom: 8 },
  card: {
    backgroundColor: '#131c33',
    borderColor: '#223052',
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 10,
  },
  cardTitle: { color: '#e2e8f0', fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#94a3b8', fontSize: 14, flexShrink: 0 },
  rowValue: { fontSize: 14, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  footer: { color: '#475569', fontSize: 12, textAlign: 'center', marginTop: 6 },
});
