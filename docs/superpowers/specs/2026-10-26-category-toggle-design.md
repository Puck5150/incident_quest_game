# Category toggle for the Ops board

Date: 2026-10-26
Status: draft for review

## Purpose

The Ops board (`HomeScreen`) renders the world map plus one section per track.
With OpenStack there are 12 tracks and well over a hundred incident cards in a
single scroll. The player wants the board to stay manageable as tracks grow:
a toggle at the top of the page that groups tracks into categories and shows
only the selected ones.

### What was asked for

- A toggle at the top of the page for platform categories.
- Multi-select chips: one per category, click to show or hide, several can be
  visible at once, and the choice is remembered between visits.
- It filters the Ops board's track sections **and** the world map together.
  The Clearance map (skill tree) keeps showing everything.

### Defaults chosen with the player

- Every category is on the first time.
- The selection is saved in the browser (`localStorage`) and the page works if
  storage is unavailable.
- The last category cannot be turned off.
- A track's category is data in `content/tracks.yaml`.
- Each chip shows how many incidents are open in it.

### Success criteria

- The board can be reduced to one category and shows only that category's
  sectors and map stations.
- The selection survives a reload.
- A new track cannot be added without choosing a category.
- Arriving from the Clearance map at a hidden track still lands on it.

## Design

### Categories

Four fixed categories, defined once in `src/game/categories.ts`:

| id | label | tracks |
|---|---|---|
| `foundations` | Foundations | networking, linux, databases |
| `platform` | Platform | containers, iac, cicd, microservices |
| `cloud` | Cloud | aws, azure, gcp, cloud-design |
| `private-cloud` | Private cloud | openstack |

`categories.ts` exports the ordered list (`id` and `label`) and the `Category`
type. Chip order is the order above. Sections on the board keep the existing
`tracks.yaml` order; they are not regrouped by category.

### Data

`TrackSchema` (`src/schema/scenario.ts`) gains a required
`category: z.enum(['foundations', 'platform', 'cloud', 'private-cloud'])`.
The enum values are the single source for `categories.ts` (the ordered list is
typed against the schema's enum so they cannot drift). All 12 tracks in
`content/tracks.yaml` get a `category`. A track without one fails content
validation.

### State: `src/game/categoryFilter.ts`

Pure functions plus load/save, no React.

- `ALL`: the full set of category ids.
- `loadCategories(storage = localStorage): Set<Category>`: reads the key
  `incident-quest:categories` (a JSON array of ids). Unknown ids are dropped.
  If the key is missing, unreadable, malformed, or leaves the set empty, it
  returns all categories. Storage access is wrapped in try/catch, as in
  `progress.ts`.
- `saveCategories(set, storage = localStorage)`: writes the array; failures are
  swallowed.
- `toggleCategory(selected, id): Set<Category>`: returns a new set with `id`
  flipped. If that would leave the set empty, it returns the set unchanged.
- `revealCategory(selected, id): Set<Category>`: returns a set that includes
  `id` (used for the focus jump below).

The key is separate from the progress save (`incident-quest:v1`) so a bad value
here cannot affect progress.

### UI

**`src/components/CategoryChips.tsx`**: a `role="group"` with the accessible
name "Show categories". One `<button>` per category with `aria-pressed`.
Visible text is the label plus the open count, for example `Cloud · 41 open`.
Pressed chips use the accent border and text; unpressed chips use the muted
line style, matching the existing difficulty and cloud chips. The last pressed
chip is `aria-disabled` and does nothing on click; a visually hidden live
region says "At least one category must stay on" when it is pressed.

**Open count** for a category is the number of queue items (incidents and
design challenges) in that category's tracks that are not in
`progress.completed`. It counts all items of tracks that have content, locked
or not, and respects the existing "unpublished items are only present when
preview is on" behaviour because it uses the same `items` list the screen
already receives. Tracks with no items contribute 0.

**`HomeScreen`** (`src/screens/HomeScreen.tsx`):

- Holds the selection in state, initialised from `loadCategories()`; every
  change calls `saveCategories`.
- Computes `visibleTracks = tracks.filter(t => selected.has(t.category))` and
  uses it for both the `WorldMap` sectors and the track sections.
- Renders `<CategoryChips>` under the title, above the shift button row.
- If `focusTrack` is set and that track's category is not selected, it adds the
  category (via `revealCategory`) before the existing focus effect runs, so the
  section exists when `focus()` is called. The effect depends on the selection
  so it re-runs once the section has rendered.
- The Clearance map, on-call shift, preview and incident screens do not read
  the selection.

The selection state could live in `App.tsx`, but nothing else needs it, so it
stays local to `HomeScreen`. It survives navigation because it is persisted.

### Error handling and edge cases

- Storage blocked or throwing: defaults to all on; toggling still works for the
  session.
- Saved ids from a future or removed category: ignored; if nothing valid is left,
  all on.
- A category with no tracks that have content: its chip still shows with
  `0 open`. (Today every category has content.)
- Preview mode adds unpublished items; they count and show exactly as they do
  today.

## Testing

- `tests/category-filter.test.ts`: default is all; round-trip through a fake
  storage; unknown ids dropped; empty and malformed stored values fall back to
  all; `toggleCategory` flips and refuses to empty the set; storage that throws
  on get and on set does not break anything.
- `tests/content.test.ts` (or a new small test): every track in
  `content/tracks.yaml` has a category, and every category in `categories.ts`
  has at least one track.
- `tests/home-categories-ui.test.tsx` (React Testing Library, in the style of
  `shift-ui.test.tsx`): chips render with open counts; toggling a chip hides
  that category's sections and its map stations; the last chip stays on;
  the selection is restored from storage on mount; `focusTrack` for a hidden
  track reveals its category.
- Existing tests that build a `Track` literal are updated for the new required
  field.

## Out of scope

- Filtering the Clearance map, on-call shift candidates or preview.
- URL parameters or deep links for the filter.
- Per-category colours or icons.
- Regrouping or reordering sections by category.
- Collapsible groups.

## Open points

None. Category membership above is the proposal from the brainstorm; changing
it is a one-line edit per track in `tracks.yaml`.
