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
  onDeletePermanently: (placeId: string) => void;
};

export function PlacesScreen({
  places,
  busy,
  error,
  onBack,
  onCreate,
  onOpenPlace,
  onDeletePermanently,
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
                onDeletePermanently={onDeletePermanently}
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
                        onDeletePermanently={onDeletePermanently}
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
  onDeletePermanently,
}: {
  place: Place;
  busy: boolean;
  onOpenPlace: (placeId: string) => void;
  onDeletePermanently: (placeId: string) => void;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => onOpenPlace(place.id)}
      >
        <Text style={styles.cardTitle}>{place.name}</Text>
        <Text style={styles.cardMeta}>
          {formatDistance(place.radiusMeters)} radius
          {place.status === 'archived' ? ' · archived' : ''}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${place.name} permanently`}
        disabled={busy}
        onPress={() => onDeletePermanently(place.id)}
        style={styles.cardDangerAction}
      >
        <Text style={styles.cardDangerText}>DELETE PERMANENTLY</Text>
      </Pressable>
    </View>
  );
}
