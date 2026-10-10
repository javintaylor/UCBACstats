// PREPARED ONLY. Must live with the existing website's Script Properties.
// Private function: no new public google.script.run method, trigger or writer.
function ucbacAppDailySummary_(e) {
  var result;
  try {
    if (!e || e.queryString !== 'appDailySummary=1' || !e.postData || e.postData.type !== 'application/json' ||
        typeof e.postData.contents !== 'string' || Utilities.newBlob(e.postData.contents).getBytes().length > 8192) throw new Error('Unavailable');
    var props = PropertiesService.getScriptProperties();
    var source = UCBACDailySummarySource.createSummarySource({
      getScope: function () {
        if (props.getProperty('APP_DAILY_SUMMARY_ENABLED') !== 'true') return null;
        var value = props.getProperty('APP_DAILY_SUMMARY_SCOPE');
        if (!value || value.length > 2048) return null;
        return JSON.parse(value);
      },
      getKey: function () { return props.getProperty('APP_DAILY_SUMMARY_KEY'); },
      sourceScriptId: ScriptApp.getScriptId(),
      readProperty: function (name) { return props.getProperty(name); },
      currentSeason: function () { return String(CONFIG.CURRENT_SEASON); }
    });
    result = source(JSON.parse(e.postData.contents));
  } catch (error) {
    // Do not forward source errors or pass this body into the advertising logger.
    result = { error: 'Stored summary unavailable.' };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
