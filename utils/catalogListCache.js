// One shared copy of "every catalogue with its customer-visible products",
// used by the phone's catalogue list. Building it costs several database
// reads, and every phone asks for it at sign-in and again after each edit, so
// the server builds it once and every phone gets its own filtered share.
//
// It is dropped as soon as a catalogue, product or clasp picture is written
// through the app routes (see broadcastCatalogChange). The short lifetime
// covers writes that come in another way, such as the staff portal or scripts.
const TTL_MS = 15 * 1000;

let snapshot = null; // { builtAt, value }
let loading = null; // a build in progress, shared by everyone who asks meanwhile
let generation = 0; // bumped on every drop so an old build cannot refill the cache

const invalidate = () => {
  generation += 1;
  snapshot = null;
  loading = null;
};

const get = async build => {
  if (snapshot && Date.now() - snapshot.builtAt < TTL_MS) return snapshot.value;
  if (loading) return loading;
  const startedIn = generation;
  const attempt = build()
    .then(value => {
      if (generation === startedIn) snapshot = { builtAt: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (loading === attempt) loading = null;
    });
  loading = attempt;
  return attempt;
};

module.exports = { get, invalidate, TTL_MS };
