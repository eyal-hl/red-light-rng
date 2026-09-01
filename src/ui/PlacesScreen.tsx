import { Pressable, ScrollView, Text, View } from 'react-native';

import type { Place } from '../domain/place';
import { formatDistance } from '../domain/geo';
import { styles } from './styles';

type PlacesScreenProps = {
  places: Place[];
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
  onOpenPlace: (placeId: string) => void;
};

export function PlacesScreen({
  places,
  busy,
  error,
  onBack,
  onCreate,
  onOpenPlace,
}: PlacesScreenProps) {
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← HOME</Text>
        </Pressable>
        <Text style={styles.title}>Places</Text>
        <Text style={styles.subtitle}>
          Saved endpoints used for automatic start and finish. Creating or editing places is not part of
          START.
        </Text>
        {places.length === 0 ? (
          <Text style={styles.emptyText}>No places yet.</Text>
        ) : (
          places.map((place) => (
            <Pressable
              key={place.id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onOpenPlace(place.id)}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{place.name}</Text>
              <Text style={styles.cardMeta}>
                {formatDistance(place.radiusMeters)} radius
                {place.status === 'archived' ? ' · archived' : ''}
              </Text>
            </Pressable>
          ))
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCreate}
            style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>+ NEW PLACE</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
