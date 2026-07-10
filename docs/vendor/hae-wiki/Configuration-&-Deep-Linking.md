# Configuration

## General

REST API Automations can be configured via customized deep links. This is great for use cases where you would like to integrate Health Auto Export with your own or a third-party platform

## FAQ
**How do I get the most detailed data?**

To put it simply, if you want the most detailed data available, you should use the default settings for `Period` and `Aggregation`. This will provide second-by-second detail for Heart Rate.

## Fields

### URL

The destination URL of the POST request. Both `http` and `https` are allowed.

### Name

The display name of the automation.

### Headers

`Content-Type` headers are automatically set for the export format selected in-app or specified by the URL scheme:

- `Content-Type:application/json` is automatically set for JSON format

- `Content-Type:multipart/form-data` is automatically set for CSV format

### Format

JSON format exports a single object with `metrics` and `workouts` fields containing the requested data.

CSV format exports two files, one each for health metrics and workouts.

### Period

- `Default`: Syncs data for the full previous day plus data up to the current date and time. This sync will run multiple times daily.

- `Since Last Sync`: On each sync, exports all data since the last time the export ran up until the current date and time. This sync will run multiple times daily.

- `Today`: Syncs all data for the current date up to the current time. This sync will run multiple times daily.

- `Yesterday`: Syncs all data for the full previous day. This sync will run only once daily.

- `Previous 7 Days`: Syncs data for the full previous seven days. This sync will run only once daily.

### Interval

The following are accepted values for setting the aggregation interval for data to be synced. At this time, it is only possible to use the `days` interval with CSV exports.

- `Default`: When `Default` is set, and exporting in JSON format, Health Auto export uses the seconds interval for the Heart Rate metric and minutes for other metrics. This provides the most detailed output for Heart Rate data. When exporting to CSV, the `days` interval is used for all metrics.

- `minutes`: Data is aggregated minute-by-minute

- `days`: Data is aggregated day-by-day

- `weeks`: Data is aggregated week-by-week

- `months`: Data is aggregated month-by-month

- `years`: Data is aggregated year-by-year

## Deep Linking

An API Export can be configured via URL scheme. This means if you'd like to build a service that integrates with Health Auto Export, your users can click on a link to populate API Export fields as long as they have Health Auto Export installed.

### URL Scheme

Configuration of API Export fields is done via the following URL scheme:

`com.HealthExport://automation`

### Parameters

`url (required)`: 

Enter a valid URL to send exported data.

`name (optional`

Enter a display name for the automation. The default name is "New Automation."

`headers (optional)`:

Enter headers as a comma-separated list of key-value pairs. `Content-Type` headers are automatically applied according the selected format type (e.g. `application/json`)

`format (optional)`:

Export format options are CSV and JSON. The default is JSON.

- `json (Default)`
- `csv`

`datatype (optional)`:

Set the type of data that will be exported by the automation:

- `healthmetrics (Default)`
- `workouts`
- `symptoms`
- `workouts`

`aggregatedata (optional)`

Export aggregated or disaggregated data (where available):

- `true (Default)`
- `false`

`period (optional)`:

The following are accepted values for setting the time span for data to be synced. The default is `none`.

- `none (Default)`
- `lastsync (Since Last Sync)`
- `today (Today)`
- `yesterday (Yesterday)`
- `previous7Days (Previous 7 Days)`

`interval (optional)`:

The following are accepted values for setting the aggregation interval for data to be synced. At this time, it is only possible to use the `days` interval with CSV exports.

- `none (Default)`
- `minutes`
- `hours`
- `days`
- `weeks`
- `months`
- `years`

`syncinterval (optional)`:

The following are accepted values for the sync cadence interval:

- `minutes (Default)`
- `hours`
- `days`
- `weeks`

`syncquantity (optional)`:

The following are acceptable value ranges corresponding to the associated interval. The `min` value is used as the default value for each case:

- `minutes`: `min: 5`, `max: 60`
- `hours`: `min: 1`, `max: 24`
- `days`: `min: 1`, `max: 7`
- `weeks`: `min: 1`, `max: 1`

`enabled (optional)`:

Set an automation as enabled/disabled when imported. An automation will be disabled by default, giving the user ultimate control over their data.

- `false (Default)`
- `true`

### Complete Example

`com.HealthExport://automation?url=https://example.com/user?123&headers=Authorization,123456&name=Test%20Link&format=json&period=lastsync&interval=minutes&enabled=true&datatype=workouts&aggregatedata=false&syncinterval=hours&syncquantity=5`


