'use strict';
/* netbox.js — client for the NetBox read endpoints. Inside NetBox these are direct
   ORM queries restricted to the requester's object permissions; standalone they were
   the token-holding proxy. The UI never calls NetBox directly. */

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

  /** Racks in a Location. Returns { racks:[{id,name,url,u_height}] }. */
  async racks(locationId) {
    return Api.get(`/api/netbox/racks?location=${encodeURIComponent(locationId)}`);
  }

  /** Unracked devices in a Location. Returns { devices:[{id,name,url}] }. */
  async devices(locationId) {
    return Api.get(`/api/netbox/devices?location=${encodeURIComponent(locationId)}`);
  }
}
