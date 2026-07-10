# JSON Format

JSON data exported will follow the format described below. All data will be encapsulated in a `data` object with arrays for each supported data type as inddicated below:

```json
"data": {
    "metrics": <Array>,
    "workouts": <Array>,
    "stateOfMind": <Array>,
    "medications": <Array>,
    "symptoms": <Array>,
    "cycleTracking": <Array>,
    "ecg": <Array>,
    "heartRateNotifications": <Array>
}
```

## Health Metrics

The `metrics` field is an array of objects, each containing data for a particular health metric. Most health metrics data follows a common structure. Exceptions to this format are also documented below:

### Common Format

- `name`: `<String>`
- `units`: `<String>`
- `data`: `<Array>`

The `data` array attached to a health metric will contain a quantity value that corresponds to the associated `units` value, along with a timestamp:

```json
"data": [
    {
        "qty": <Number>,
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>
    }
]
```

### Blood Pressure

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "systolic": <Number>,
        "diastolic": <Number>
    }
]
```

### Heart Rate

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "Min": <Number>,
        "Avg": <Number>,
        "Max": <Number>
    }
]
```

### Sleep Analysis

Sleep data payloads may vary depending on if data aggregation is toggled on or off.

#### Aggregated

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd)>,
        "totalSleep": <Number>,
        "asleep": <Number>,
        "core": <Number>,
        "deep": <Number>,
        "rem": <Number>,
        "sleepStart": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "sleepEnd": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "inBed": <Number>,
        "inBedStart": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "inBedEnd": <Date (yyyy-MM-dd HH:mm:ss Z)> ,
    }
]
```

#### Unaggregated

```json
"data": [
    {
        "startDate": <Date (yyyy-MM-dd)>,
        "endDate": <Number>,
        "qty": <Number>,
        "value": <String> (Awake | Asleep* | In Bed | Core | REM | Deep | Unspecified),
        "deep": <Number>,
        "rem": <Number>,
        "sleepStart": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "sleepEnd": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "inBed": <Number>,
        "inBedStart": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "inBedEnd": <Date (yyyy-MM-dd HH:mm:ss Z)> ,
    }
]
```

\*`Asleep` refers to an uncategorized sleep phase (rather than total time asleep). This may occur if the data source does not support sleep phase tracking.

### Blood Glucose

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "qty": <Number>,
        "mealTime": <String> ("Before Meal" | "After Meal" | "Unspecified")
    }
]
```

### Sexual Activity

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "Unspecified":<Number>,
        "Protection Used":<Number>,
        "Protection Not Used":<Number>,
    }
]
```

### Handwashing

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "qty": <Number>,
        "value":<String> ("Complete" | "Incomplete")
    }
]
```

### Toothbrushing

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "qty": <Number>,
        "value":<String> ("Complete" | "Incomplete")
    }
]
```

### Insulin Delivery

```json
"data": [
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "qty": <Number>,
        "reason":<String> ("Bolus" | "Basal")
    }
]
```

## Medications

```json
{
    "displayText": <String>,
    "nickname": <String | undefined>,
    "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
    "end": <Date (yyyy-MM-dd HH:mm:ss Z) | undefined>,
    "scheduledDate": <Date (yyyy-MM-dd HH:mm:ss Z) | undefined>,
    "form": <String> ("Capsule" | "Cream" | "Device" | "Drops" | "Foam" | "Gel" | "Inhaler" | "Injection" | "Liquid" | "Lotion" | "Ointment" | "Patch" | "Powder" | "Spray" | "Suppository" | "Tablet" | "Topical" | "Unknown"),
    "status": <String> ("Not Interacted" | "Notification Not Sent" | "Snoozed" | "Taken" | "Skipped" | "Not Logged" | "Unspecified"),
    "isArchived": <Boolean>,
    "dosage": <Number | undefined>
    "codings": [
        {
            "code": <String>,
            "system": <String>,
            "version": <String | undefined>,
        }
    ]
}
```

## Symptoms

Health Auto Export supports all health symptoms data.

```json
[
    {
        "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "name": <String>,
        "severity": <String>,
        "userEntered": <Boolean>,
        "source": <String>
    }
]
```

## State of Mind

Health Auto Export supports all State of Mind data.

```json
{
    "id": String,
    "start": String,
    "end": String,
    "kind": String,
    "labels": Array<String>,
    "associations": Array<String>,
    "valence": Number,
    "valenceClassification": Number,
    "metadata": Object<String:String>
}
```

## Heart Rate Notifications

Heart Rate Notification data is structured quite differently from other health metric data. At the top level, there is information regarding the start and end of the event. An event threshold is included for high and low heart rate events.

Additional metadata gathered during the heart rate event is included for hear rate and heart rate variation.

The `threshold` field is only included for high and low heart rate notifications)

```json
[
    {
        "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "threshold": <Number> (For high and low heart rate notifications)
        "heartRate": [
            {
                "hr": <Number>,
                    "units": "bpm",
                    "timestamp": {
                        "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
                        "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
                        "interval": {
                            "duration": <Number>,
                            "units": "s" (seconds)
                        }
                    }
            }
        ],
        "heartRateVariation": [
            {
                "hrv": <Number>,
                "units": "ms",
                "timestamp": [
                    "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
                    "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
                    "interval": [
                        "duration": <Number>,
                        "units": "s"
                    ]
                ]
            }
        ]
    }
]
```

## ECG

Health Auto Export supports ECG data export in the following format:

```json
[
    {
        "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "classification": <String> ("Sinus Rhythm" | "Atrial Fibrillation" | "High Heart Rate" | "Inconclusive Low Heart Rate" | "Inconclusive High Heart Rate" | "Inconclusive" | "Inconclusive Poor Recording" | "Inconclusive" | "Unrecognized" ),
        "severity": <String>,
        "averageHeartRate": <Number>,
        "numberOfVoltageMeasurements": <Number>
        "voltageMeasurements": Array<VoltageMeasurement>
        "samplingFrequency": <Number> (Hz)
        "source": <String>
    }
]
```

Voltage Measurement

```json
[
    {
        "date": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "voltage": <Number>,
        "units": <String>
    }
]
```

## Workouts

The `workouts` field is an array of objects, each containing data for a particular workout. Workouts follow a common structure. Units for a particular field can be variable, depending on user unit preferences (e.g. "kcal" vs "kJ"), and denoted as `<String>`, or units can fixed and expressed by a hardcoded value.

### Workouts v2

```json
{
  "id": <String>,
  "name": <String>,
  "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
  "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
  "duration": <Number (seconds)>,


  // Optional fields
  "location": <String | undefined>, ("Indoor" | "Outdoor" | "Pool" | "Open Water")
  "isIndoor": <Boolean | undefined>,
  "activeEnergyBurned": { "qty": <Number>, "units": <String> } | undefined>,
  "totalEnergy": { "qty": <Number>, "units": <String> } | undefined>,
  "intensity": { "qty": <Number>, "units": "MET" } | undefined>,
  "distance": { "qty": <Number>, "units": <String ("mi" | "km")> } | undefined>,
  "speed": { "qty": <Number>, "units": <String ("mph" | "kmph")> } | undefined>,
  "temperature": { "qty": <Number>, "units": <String ("degF" | "degC")> } | undefined>,
  "humidity": { "qty": <Number>, "units": "%" } | undefined>,
  "avgSpeed": { "qty": <Number>, "units": <String ("mph" | "kmph")> } | undefined>,
  "maxSpeed": { "qty": <Number>, "units": <String ("mph" | "kmph")> } | undefined>,
  "elevationUp": { "qty": <Number>, "units": <String ("ft" | "m")> } | undefined>,
  "elevationDown": { "qty": <Number>, "units": <String ("ft" | "m")> } | undefined>,
  "lapLength": { "qty": <Number>, "units": <String ("mi" | "km")> } | undefined>,
  "strokeStyle": <String | undefined> ("Backstroke" | "Breaststroke" | "Butterfly" | "Freestyle" | "Mixed" | "Kickboard" | "Unknown"),
  "swolfScore": <Number | undefined>,
  "salinity": <String | undefined> ("Fresh Water" | "Salt Water"),
  "totalSwimmingStrokeCount": { "qty": <Number>, "units": "count" } | undefined>,
  "activeEnergy": <Array(QuantityData) | undefined>,
  "basalEnergy": <Array(QuantityData) | undefined>,
  "cyclingCadence": <Array(QuantityData) | undefined>,
  "cyclingDistance": <Array(QuantityData) | undefined>,
  "cyclingPower": <Array(QuantityData) | undefined>,
  "cyclingSpeed": <Array(QuantityData) | undefined>,
  "swimDistance": <Array(QuantityData) | undefined>,
  "swimStroke": <Array(QuantityData) | undefined>,
  "stepCount": <Array(QuantityData) | undefined>,
  "stepCadence": { "qty": <Number>, "units": "spm" } | undefined>,
  "flightsClimbed": { "qty": <Number>, "units": "count" } | undefined>,
  "swimCadence": { "qty": <Number>, "units": "spm" } | undefined>,
  "walkingAndRunningDistance": <Array(QuantityData) | undefined>,
  "heartRate": { "min": { "qty": <Number>, "units": <String> }, "avg": { "qty": <Number>, "units": <String> }, "max": { "qty": <Number>, "units": <String> } } | undefined>,
  "maxHeartRate": { "qty": <Number>, "units": <String> } | undefined>,
  "avgHeartRate": { "qty": <Number>, "units": <String> } | undefined>,
  "heartRateData": <Array(HeartRateData) | undefined>,
  "heartRateRecovery": <Array(HeartRateData) | undefined>,
  "metadata": <String:Any | undefined>,
  "route": <Array(Location) | undefined>
}
```

**QuantityData**

```json
{
    "date": <String (yyyy-MM-dd HH:mm:ss Z)>,
    "qty": <Number>,
    "units": <String>,
    "source": <String | undefined>
}
```

**Heart Rate Data**

```json
{
    "date": <String (yyyy-MM-dd HH:mm:ss Z)>,
    "Min": <Number>,
    "Avg": <Number>,
    "Max": <Number>,
    "units": <String>,
    "source": <String | undefined>
}
```

**Location**

```json
{
    "latitude": <Number>,
    "longitude": <Number>,
    "altitude": <Number>,
    "course": <Number>,
    "courseAccuracy": <Number>,
    "horizontalAccuracy": <Number>,
    "verticalAccuracy": <Number>,
    "timestamp": <String>,
    "speed": <Number>,
    "speedAccuracy": <Number>
}
```

### Workouts v1

```json
[
    {
        "name": <String>,
        "start": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "end": <Date (yyyy-MM-dd HH:mm:ss Z)>,
        "heartRateData": [
            "date": <Date (yyyy-MM-dd HH:mm:ss Z)>
            "qty": <Number>,
            "units": "count"
        ],
        "heartRateRecovery": [
            {
                "date": <Date (yyyy-MM-dd HH:mm:ss Z)>
                "qty": <Number>,
                "units": "count"
            }
        ],
        "route": [
            {
                "lat": <Number>,
                "lon": <Number>,
                "altitude": <Number (in meters)>,
                "timestamp" <Date (yyyy-MM-dd HH:mm:ss Z)>
            }
        ],
        "totalEnergy": {
            "qty": <Number>,
            "units": <String>
        },
        "activeEnergy": {
            "units": <String>,
            "qty": <Number>
        },
        "maxHeartRate": {
            "qty": <Number>,
            "units": "bpm"
        },
        "avgHeartRate": {
            "qty": <Number>,
            "units": "bpm"
        },
        "stepCount": {
            "qty": <Number>,
            "units": "steps"
        },
        "stepCadence": {
            "qty": <Number>,
            "units": "spm"
        },
        "totalSwimmingStrokeCount": {
            "qty": <Number>,
            "units": "count"
        },
        "swimCadence": {
            "qty": <Number>,
            "units": "spm"
        },
        "distance": {
            "qty": <Number>,
            "units": <String>
        },
        "speed": {
            "qty": <Number>,
            "units": <String>
        },
        "flightsClimbed": {
            "qty": <Number>,
            "units": "count"
        },
        "intesity": {
            "qty": <Number>,
            "units": "MET"
        },
        "temperature": {
            "qty": <Number>,
            "units": <String>
        },
        "humidity": {
            "qty": <Number>,
            "units": "%"
        },
        "elevation": {
            "ascent": <Number>,
            "descent": <Number>,
            "units": <String>
        }
    }
]
```