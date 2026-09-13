import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

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
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onEditCourse: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onDelete: (() => void) | null;
};

export function RouteDetailScreen({
  route,
  summary,
  busy,
  error,
  onBack,
  onEditCourse,
  onRename,
  onArchive,
  onDelete,
}: RouteDetailScreenProps) {
  const distance = pathDistanceMeters(route.referencePath);
  const checkpoints = checkpointMapPoints(route.referencePath, route.checkpoints);
  const [nameDraft, setNameDraft] = useState({ routeId: route.id, name: route.name });
  const name = nameDraft.routeId === route.id ? nameDraft.name : route.name;

  const confirmArchive = () => {
    Alert.alert(
      'Archive path variant?',
      'It will leave the journey list but attempts, geometry, and raw GPS stay on the device. The same path will not immediately reappear as a new variant.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: onArchive,
        },
      ],
    );
  };

  const confirmDelete = () => {
    Alert.alert('Delete route?', 'The saved route will be removed. The original GPS recording is kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onDelete?.(),
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← JOURNEY</Text>
        </Pressable>
        <Text style={styles.title}>{route.name}</Text>
        <Text style={styles.subtitle}>
          {transportationModeIcon(route.transportationMode)}{' '}
          {transportationModeLabel(route.transportationMode)}
          {route.kind === 'discovered' ? ' · discovered' : ''}
        </Text>

        <View style={styles.mapSlot}>
          <RouteMap
            path={route.referencePath}
            startZone={route.startZone}
            finishZone={route.finishZone}
            checkpoints={checkpoints}
          />
        </View>

        <TextInput
          accessibilityLabel="Path variant name"
          value={name}
          onChangeText={(next) => setNameDraft({ routeId: route.id, name: next })}
          placeholder="Path name"
          placeholderTextColor="#6b7076"
          style={styles.input}
        />

        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Variant PB</Text>
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
          <Text style={styles.statLabel}>Compatible attempts</Text>
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
          These stats are path-specific. Official journey times and the journey PB do not depend on matching
          this path.
        </Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || name.trim().length === 0 || name.trim() === route.name}
            onPress={() => onRename(name)}
            style={[
              styles.button,
              styles.secondaryButton,
              busy || name.trim().length === 0 || name.trim() === route.name ? styles.disabledButton : null,
            ]}
          >
            <Text style={styles.buttonText}>SAVE NAME</Text>
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
            onPress={confirmArchive}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>ARCHIVE PATH VARIANT</Text>
          </Pressable>
          {onDelete ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={confirmDelete}
              style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>DELETE PATH VARIANT</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
