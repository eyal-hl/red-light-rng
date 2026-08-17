import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { checkpointMapPoints } from '../domain/course-layout';
import { formatDistance, pathDistanceMeters } from '../domain/geo';
import {
  transportationModeIcon,
  transportationModeLabel,
  type Route,
} from '../domain/route';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

type RouteDetailScreenProps = {
  route: Route;
  attemptCount: number;
  canArm: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onArmRun: () => void;
  onEditCourse: () => void;
  onDelete: () => void;
};

export function RouteDetailScreen({
  route,
  attemptCount,
  canArm,
  busy,
  error,
  onBack,
  onArmRun,
  onEditCourse,
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
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>{formatDistance(distance)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Checkpoints</Text>
          <Text style={styles.statValue}>{route.checkpoints.length}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Reference points</Text>
          <Text style={styles.statValue}>{route.referencePath.length}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Attempts</Text>
          <Text style={styles.statValue}>{attemptCount}</Text>
        </View>
        <Text style={styles.mutedText}>
          {attemptCount === 0 ? 'No attempts yet.' : 'Official timing starts after you arm and depart.'}
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
