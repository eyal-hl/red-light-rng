import { useEffect, useState, type ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { styles } from './styles';

type DeferredMapSlotProps = {
  label?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

export function DeferredMapSlot({
  label = 'Loading map…',
  style,
  children,
}: DeferredMapSlotProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setReady(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);

  if (!ready) {
    return (
      <View style={style}>
        <Text style={styles.mutedText}>{label}</Text>
      </View>
    );
  }

  return children;
}
