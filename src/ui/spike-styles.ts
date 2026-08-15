import { StyleSheet } from 'react-native';

export const spikeStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#111111',
  },
  content: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  title: {
    marginBottom: 16,
  },
  titleText: {
    color: '#f5f5f5',
    fontSize: 22,
    fontWeight: '700',
  },
  statusBlock: {
    marginBottom: 16,
    gap: 6,
  },
  statusText: {
    color: '#e6e6e6',
    fontSize: 16,
  },
  warningText: {
    color: '#e6c07b',
    fontSize: 14,
    marginTop: 8,
  },
  errorText: {
    color: '#f07178',
    fontSize: 14,
    marginTop: 8,
  },
  noteText: {
    color: '#9aa0a6',
    fontSize: 13,
    marginBottom: 16,
  },
  actions: {
    gap: 12,
    marginBottom: 24,
  },
  button: {
    minHeight: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  startButton: {
    backgroundColor: '#2e7d4f',
  },
  stopButton: {
    backgroundColor: '#8a2f2f',
  },
  disabledButton: {
    opacity: 0.45,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  samplesHeading: {
    marginBottom: 8,
  },
  samplesHeadingText: {
    color: '#f5f5f5',
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    color: '#9aa0a6',
    fontSize: 14,
  },
  sampleRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333333',
  },
  sampleText: {
    color: '#d0d0d0',
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
