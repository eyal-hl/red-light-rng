import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { checkpointMapPoints } from '../domain/course-layout';
import { formatElapsed } from '../domain/duration';
import { formatDistance, pathDistanceMeters } from '../domain/geo';
import {
  transportationModeIcon,
  transportationModeLabel,
  type Route,
} from '../domain/route';
import type { RouteCompetitiveSummary } from '../domain/attempt-analysis';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

type RouteDetailScreenProps = {
  route: Route;
  summary: RouteCompetitiveSummary | null;
  canArm: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onArmRun: () => void;
  onEditCourse: () => void;
  onHistory: () => void;
  onDelete: () => void;
};

export function RouteDetailScreen({
  route,
  summary,
  canArm,
  busy,
  error,
  onBack,
  onArmRun,
  onEditCourse,
  onHistory,
  onDelete,
}: RouteDetailScreenProps) {
  const distance = pathDistanceMeters(route.referencePath);
  const checkpoints = checkpointMapPoints(route.referencePath, route.checkpoints);

  const confirmDelete = () => {
    Alert.alert('Delete route?', 'The saved route will be removed. The original GPS recording is kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: onDelete,
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← YOUR ROUTES</Text>
        </Pressable>
        <Text style={styles.title}>{route.name}</Text>
        <Text style={styles.subtitle}>
          {transportationModeIcon(route.transportationMode)}{' '}
          {transportationModeLabel(route.transportationMode)}
        </Text>

        <View style={styles.mapSlot}>
          <RouteMap
            path={route.referencePath}
            startZone={route.startZone}
            finishZone={route.finishZone}
            checkpoints={checkpoints}
          />
        </View>

        <View style={styles.statRow}>
          <Text style={styles.statLabel}>PB</Text>
          <Text style={styles.statValue}>
            {summary?.pbTimeMs == null ? '—' : formatElapsed(summary.pbTimeMs)}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Last</Text>
          <Text style={styles.statValue}>
            {summary?.lastTimeMs == null ? '—' : formatElapsed(summary.lastTimeMs)}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Attempts</Text>
          <Text style={styles.statValue}>{summary?.rankedAttemptCount ?? 0}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Sum of Best</Text>
          <Text style={styles.statValue}>
            {summary?.sumOfBestMs == null ? '—' : formatElapsed(summary.sumOfBestMs)}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>{formatDistance(distance)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Checkpoints</Text>
          <Text style={styles.statValue}>{route.checkpoints.length}</Text>
        </View>
        <Text style={styles.mutedText}>
          {(summary?.rankedAttemptCount ?? 0) === 0
            ? 'No ranked attempts yet.'
            : 'Official timing starts after you arm and depart.'}
        </Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !canArm}
            onPress={onArmRun}
            style={[styles.button, styles.primaryButton, busy || !canArm ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>ARM RUN</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onHistory}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>HISTORY</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onEditCourse}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>EDIT COURSE</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={confirmDelete}
            style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>DELETE ROUTE</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

