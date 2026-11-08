export const categories = ['healthy', 'idf_outage', 'localized_link_fault', 'switch_bottleneck', 'isp_degradation', 'unresolved'];
const average = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function evaluationReport(store) {
  const trials = store.records('trials', 100000);
  const matrix = Object.fromEntries(categories.map(a => [a, Object.fromEntries(categories.map(p => [p, 0]))]));
  const detections = [], localizations = [], reductions = [];
  let tp = 0, tn = 0, fp = 0, fn = 0, missed = 0;
  for (const trial of trials) {
    matrix[trial.actualCategory][trial.predictedCategory]++;
    const actualFault = trial.actualCategory !== 'healthy';
    const detected = trial.predictedCategory !== 'healthy';
    if (actualFault && detected) tp++;
    else if (actualFault) { fn++; missed++; }
    else if (detected) fp++;
    else tn++;
    if (actualFault && trial.detectedAt) detections.push(Date.parse(trial.detectedAt) - Date.parse(trial.startedAt));
    if (actualFault && trial.predictedCategory === trial.actualCategory && trial.localizedAt) {
      const elapsed = Date.parse(trial.localizedAt) - Date.parse(trial.startedAt);
      localizations.push(elapsed);
      if (trial.traditionalDiagnosticMs > 0) reductions.push((trial.traditionalDiagnosticMs - elapsed) / trial.traditionalDiagnosticMs * 100);
    }
  }
  const ratio = (a, b) => b ? a / b : null;
  const precision = ratio(tp, tp + fp), recall = ratio(tp, tp + fn);
  const perClass = Object.fromEntries(categories.map(category => {
    const truePositive = matrix[category][category];
    const predicted = categories.reduce((s, a) => s + matrix[a][category], 0);
    const actual = categories.reduce((s, p) => s + matrix[category][p], 0);
    const p = ratio(truePositive, predicted), r = ratio(truePositive, actual);
    return [category, { support: actual, precision: p, recall: r, f1: p !== null && r !== null ? (p + r ? 2 * p * r / (p + r) : 0) : null }];
  }));
  const mapping = store.records('mappingChecks', 100000);
  const notifications = store.records('notifications', 100000).filter(n => n.status === 'submitted');
  return { trialCount: trials.length, confusionMatrix: matrix, detection: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn, accuracy: ratio(tp + tn, trials.length), precision, recall, f1: precision !== null && recall !== null ? (precision + recall ? 2 * precision * recall / (precision + recall) : 0) : null }, perClass, missedIncidents: missed, meanTimeToDetectMs: average(detections), meanTimeToIsolateMs: average(localizations), meanDiagnosticTimeReductionPercent: average(reductions), verifiedMappingAccuracy: ratio(mapping.filter(m => m.correct).length, mapping.length), mappingCheckCount: mapping.length, meanNotificationSubmissionLatencyMs: average(notifications.map(n => n.incidentToSubmissionMs)), note: 'Trial ground truth and timing require independent verification. Submission does not establish recipient delivery or acknowledgment. Null metrics have no eligible denominator.' };
}
