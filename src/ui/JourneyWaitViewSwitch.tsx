import { Pressable, Text, View } from 'react-native';

import { waitViewOptions, type JourneyWaitView } from '../product/journey-wait-view';
import { styles } from './styles';

/** Two-state segmented control: exactly one view is selected and shown below it. */
export function JourneyWaitViewSwitch({
  view,
  onSelect,
}: {
  view: JourneyWaitView;
  onSelect: (view: JourneyWaitView) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.segmentedControl}>
      {waitViewOptions(view).map((option) => (
        <Pressable
          key={option.key}
          accessibilityRole="tab"
          accessibilityLabel={option.accessibilityLabel}
          accessibilityState={{ selected: option.selected }}
          onPress={() => onSelect(option.key)}
          style={[styles.segment, option.selected ? styles.segmentSelected : null]}
        >
          <Text style={[styles.segmentText, option.selected ? styles.segmentTextSelected : null]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
