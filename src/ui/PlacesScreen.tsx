import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { partitionPlacesByStatus, type Place } from '../domain/place';
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
  const { active, archived } = partitionPlacesByStatus(places);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

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
        {active.length === 0 && archived.length === 0 ? (
          <Text style={styles.emptyText}>No places yet.</Text>
        ) : (
          <View>
            {active.map((place) => (
              <PlaceListCard
                key={place.id}
                place={place}
                busy={busy}
                onOpenPlace={onOpenPlace}
              />
            ))}
            {archived.length > 0 ? (
              <View style={styles.archivedSection}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: archivedExpanded }}
                  accessibilityLabel={
                    archivedExpanded ? 'Hide archived places' : 'Show archived places'
                  }
                  onPress={() => setArchivedExpanded((open) => !open)}
                >
                  <Text style={styles.sectionLabel}>
                    {archivedExpanded ? '▾ ARCHIVED' : `▸ ARCHIVED · ${archived.length}`}
                  </Text>
                </Pressable>
                {archivedExpanded
                  ? archived.map((place) => (
                      <PlaceListCard
                        key={place.id}
                        place={place}
                        busy={busy}
                        onOpenPlace={onOpenPlace}
                      />
                    ))
                  : null}
              </View>
            ) : null}
          </View>
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

function PlaceListCard({
  place,
  busy,
  onOpenPlace,
}: {
  place: Place;
  busy: boolean;
  onOpenPlace: (placeId: string) => void;
}) {
  return (
    <Pressable
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
  );
}
