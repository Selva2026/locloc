const mongoose = require('mongoose');

const LocationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userId: { type: String, default: null },
    timestamp: { type: String, required: true },
    epoch: { type: Number, required: true },
    coordinates: {
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      accuracy: { type: Number, default: 0 },
      altitude: { type: Number, default: null },
      altitudeAccuracy: { type: Number, default: null },
      heading: { type: Number, default: null },
      speed: { type: Number, default: null },
      speedKmH: { type: Number, default: 0 },
    },
    geo: {
      type: { type: String, default: 'Point' },
      coordinates: [Number], // [longitude, latitude]
    },
    metadata: { type: Object, default: {} },
    receivedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  }
);

LocationSchema.index({ geo: '2dsphere' });

module.exports = mongoose.model('Location', LocationSchema);
