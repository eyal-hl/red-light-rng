import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#111111',
  },
  content: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  kicker: {
    color: '#9aa0a6',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginBottom: 8,
  },
  title: {
    color: '#f5f5f5',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: '#c5c8ce',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 20,
  },
  editorHeader: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  editorSubtitle: {
    color: '#c5c8ce',
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 4,
  },
  editorMapPane: {
    flex: 1,
    minHeight: 240,
    marginHorizontal: 20,
    marginBottom: 8,
  },
  editorMap: {
    flex: 1,
    minHeight: 240,
  },
  editorStatus: {
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  editorControls: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 360,
  },
  editorControlsContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  sectionLabel: {
    color: '#9aa0a6',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginBottom: 12,
  },
  emptyText: {
    color: '#9aa0a6',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  statusText: {
    color: '#e6e6e6',
    fontSize: 16,
    marginBottom: 6,
  },
  mutedText: {
    color: '#9aa0a6',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  warningText: {
    color: '#e6c07b',
    fontSize: 14,
    marginTop: 8,
    marginBottom: 8,
  },
  errorText: {
    color: '#f07178',
    fontSize: 14,
    marginTop: 8,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#1b1b1b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1b1b1b',
  },
  cardTitle: {
    color: '#f5f5f5',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardMeta: {
    color: '#9aa0a6',
    fontSize: 14,
  },
  actions: {
    gap: 12,
    marginTop: 16,
    marginBottom: 16,
  },
  button: {
    minHeight: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryButton: {
    backgroundColor: '#2e7d4f',
  },
  secondaryButton: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#444444',
  },
  dangerButton: {
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
  input: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444444',
    backgroundColor: '#1b1b1b',
    color: '#f5f5f5',
    paddingHorizontal: 14,
    fontSize: 16,
    marginBottom: 16,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1b1b1b',
    borderWidth: 1,
    borderColor: '#444444',
  },
  modeChipSelected: {
    borderColor: '#4fc3f7',
    backgroundColor: '#163042',
  },
  modeChipText: {
    color: '#f5f5f5',
    fontSize: 14,
    fontWeight: '600',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  statLabel: {
    color: '#9aa0a6',
    fontSize: 15,
  },
  statValue: {
    color: '#f5f5f5',
    fontSize: 15,
    fontWeight: '600',
  },
  mapSlot: {
    height: 260,
    marginBottom: 16,
  },
  editorMapSlot: {
    height: 320,
    marginBottom: 16,
  },
  selectedCard: {
    borderWidth: 1,
    borderColor: '#4fc3f7',
  },
  markerAction: {
    marginTop: 12,
  },
  radiusField: {
    marginTop: 12,
  },
  radiusLabel: {
    color: '#9aa0a6',
    fontSize: 14,
    marginBottom: 8,
  },
  radiusInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  radiusInput: {
    flex: 1,
    marginBottom: 0,
  },
  radiusUnit: {
    color: '#f5f5f5',
    fontSize: 16,
    fontWeight: '600',
  },
  recordingDot: {
    color: '#f07178',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  goldText: {
    color: '#e6c07b',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  deltaFaster: {
    color: '#7dcea0',
    fontSize: 15,
    fontWeight: '700',
  },
  deltaSlower: {
    color: '#f07178',
    fontSize: 15,
    fontWeight: '700',
  },
  deltaNeutral: {
    color: '#f5f5f5',
    fontSize: 15,
    fontWeight: '700',
  },
  splitHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  splitHeaderText: {
    color: '#9aa0a6',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  splitBlock: {
    marginBottom: 12,
  },
  splitConnector: {
    color: '#9aa0a6',
    fontSize: 14,
    marginBottom: 4,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  toggleChip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1b1b1b',
    borderWidth: 1,
    borderColor: '#444444',
  },
  toggleChipSelected: {
    borderColor: '#4fc3f7',
    backgroundColor: '#163042',
  },
  toggleChipText: {
    color: '#f5f5f5',
    fontSize: 14,
    fontWeight: '600',
  },
  pbBadge: {
    color: '#7dcea0',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  movementSection: {
    marginTop: 8,
    marginBottom: 16,
  },
  attemptResultHeader: {
    paddingBottom: 8,
  },
  attemptMapPane: {
    height: 220,
    marginBottom: 8,
  },
  attemptMap: {
    flex: 1,
    minHeight: 200,
  },
  ghostChartPane: {
    flexGrow: 0,
  },
  attemptResultScroll: {
    flex: 1,
  },
  attemptResultScrollContent: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  waitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1b1b1b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1b1b1b',
  },
  waitDuration: {
    color: '#ffcc80',
    fontSize: 15,
    fontWeight: '700',
  },
  waitLocation: {
    color: '#c5c8ce',
    fontSize: 14,
    marginLeft: 12,
    flexShrink: 1,
    textAlign: 'right',
  },
  waitComparisonMore: {
    color: '#f07178',
  },
  waitComparisonLess: {
    color: '#7dcea0',
  },
  explanationSection: {
    marginTop: 12,
    marginBottom: 8,
  },
  explanationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  explanationChildRow: {
    paddingLeft: 16,
    marginBottom: 4,
  },
  explanationDuration: {
    color: '#f5f5f5',
    fontSize: 15,
    fontWeight: '700',
  },
  explanationChildDuration: {
    color: '#c5c8ce',
    fontSize: 14,
    fontWeight: '700',
  },
  explanationLabel: {
    color: '#c5c8ce',
    fontSize: 15,
    marginLeft: 12,
    flexShrink: 1,
    textAlign: 'right',
  },
  explanationChildLabel: {
    color: '#9aa0a6',
    fontSize: 13,
    marginLeft: 12,
    flexShrink: 1,
    textAlign: 'right',
  },
  statsSection: {
    marginTop: 8,
    marginBottom: 12,
  },
  trendSparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 44,
    gap: 4,
    marginTop: 4,
    marginBottom: 8,
  },
  trendBarTrack: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  trendBar: {
    width: '72%',
    backgroundColor: '#4fc3f7',
    borderRadius: 2,
    minHeight: 4,
  },
  ghostChartSection: {
    marginBottom: 8,
  },
  ghostChartPlot: {
    height: 148,
    marginTop: 4,
    marginBottom: 8,
    backgroundColor: '#1b1b1b',
    borderRadius: 10,
    overflow: 'hidden',
  },
  ghostChartPlotInner: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  ghostChartZeroLine: {
    position: 'absolute',
    height: 2,
    backgroundColor: '#c5c8ce',
    opacity: 0.85,
  },
  ghostChartCrosshair: {
    position: 'absolute',
    width: 1,
    marginLeft: -0.5,
    backgroundColor: '#f5f5f5',
    opacity: 0.7,
  },
  ghostChartYLabel: {
    position: 'absolute',
    left: 4,
    width: 38,
  },
  ghostChartXLabel: {
    position: 'absolute',
  },
  ghostChartXLabelRight: {
    position: 'absolute',
  },
  ghostChartAxisText: {
    color: '#9aa0a6',
    fontSize: 11,
    fontWeight: '600',
  },
  debugPanel: {
    marginTop: 8,
    marginBottom: 16,
    paddingTop: 8,
  },
  debugSampleCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#1b1b1b',
    borderWidth: 1,
    borderColor: '#333333',
  },
  debugSampleNav: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
});
