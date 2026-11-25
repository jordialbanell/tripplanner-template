# TripPlanner

Save places from TikTok, Instagram, Google Maps or a spreadsheet, then plan every day of a trip to the minute around them, flights and hotel included.

Built by [Jordi Albanell](https://jordialbanell.com/projects) for his own trips. Try the demo on [jordialbanell.com](https://jordialbanell.com/projects/tripplanner).

## What it does

- **Save places your way.** Paste a TikTok, Instagram or Google Maps link and it pulls out every place mentioned. Add places one at a time, or paste a whole list from a spreadsheet.
- **Plan each day to the minute** from your saved places, with travel times between stops, the weather and sunset. Send the plan to your calendar.
- **Flights and hotel** live in the trip, so each day starts and ends in the right place.
- **Works anywhere.** Google Maps for most of the world, Amap for mainland China.
- **Share a trip** as view only, or with edit rights so friends can plan with you. Switch a link off and it stops working straight away.
- **A planning chat** that knows your saved places.
- **Spots duplicates** and merges them.

## Privacy

Your trips are private. Only you (signed in with your owner password) and people you send a share link to can see a trip. Anyone else gets the demo.

## Run your own

You'll need free accounts on Supabase, Mapbox, Anthropic and Google Cloud. TikTok and Instagram links also need Apify and AssemblyAI.

1. **Use this template** (green button on GitHub) to make your own copy, then clone it.
2. `npm install`
3. **Database.** Create a Supabase project. Open its SQL Editor, paste all of `supabase/schema.sql` and press Run (if Supabase warns about Row Level Security, choose "Run without RLS": the file turns it on for every table itself). It should list 11 tables.
4. **Settings.** Copy `.env.example` to `.env.local` and fill in the required keys.
5. `npm run dev` and open http://localhost:3000. Sign in with your owner password ("Owner? Sign in") to create your first trip.
6. **Deploy.** Import the repo on [Vercel](https://vercel.com/new) and paste the same settings into its Environment Variables.

A step-by-step guide with screenshots is on the way. Leave your email on [jordialbanell.com/projects](https://jordialbanell.com/projects) (TripPlanner > Find out more) to hear when it's out.

## Built with

Next.js, React, Tailwind, Supabase, Mapbox, Amap, Google Places, Claude, Amazon Bedrock, AssemblyAI.

## Licence

MIT. Use it, change it, build on it.
