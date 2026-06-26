'use strict';
/* netbox.js — client for the server-side NetBox proxy (server.py keeps the token).
   All methods return the proxy's trimmed JSON; the UI never calls NetBox directly. */

class NetBoxClient {
  /** Rooms (child Locations) of a floor; falls back to all site Locations.
   *  Returns { floor:{...}|null, rooms:[{id,name,slug,url,depth}] }. */
  async rooms(siteSlug, floorSlug) {
    return Api.get(`/api/netbox/rooms?site=${encodeURIComponent(siteSlug)}`
      + `&floor=${encodeURIComponent(floorSlug)}`);
  }

  /** Free-text Location search within a site. Returns { rooms:[...] }. */
  async locations(siteSlug, q) {
    return Api.get(`/api/netbox/locations?site=${encodeURIComponent(siteSlug)}`
      + `&q=${encodeURIComponent(q || '')}`);
  }

  /** Refresh the rack cache for one Location (the selected room). Server merges it
   *  into rackcache.json. Returns { ok, racks, devices }. */
  async syncRoom(locationId, name) {
    return Api.post('/api/netbox/sync-room', { location: locationId, name: name || '' });
  }

  /** Racks in a Location. Returns { racks:[{id,name,url,u_height}] }. */
  async racks(locationId) {
    return Api.get(`/api/netbox/racks?location=${encodeURIComponent(locationId)}`);
  }

  /** Unracked devices in a Location. Returns { devices:[{id,name,url}] }. */
  async devices(locationId) {
    return Api.get(`/api/netbox/devices?location=${encodeURIComponent(locationId)}`);
  }
}
