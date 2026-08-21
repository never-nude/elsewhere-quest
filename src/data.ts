import { STATIONS, type SignalCountry } from './theme'

export type Signal = {
  id: string
  name: string
  location: SignalCountry
  region: string
  timeZone: string
  mood: string
  topic: string
  duration: number
  language: string
  color: string
}

const signalSeeds: Omit<Signal, 'color'>[] = [
  {
    id: 'ines',
    name: 'Inês',
    location: 'Portugal',
    region: 'Western Europe',
    timeZone: 'Europe/Lisbon',
    mood: 'A thoughtful question',
    topic: 'When did a wrong turn become the right one?',
    duration: 20,
    language: 'English · Portuguese',
  },
  {
    id: 'adwoa',
    name: 'Adwoa',
    location: 'Ghana',
    region: 'West Africa',
    timeZone: 'Africa/Accra',
    mood: 'Trade stories',
    topic: 'The small rituals that make a place feel like home.',
    duration: 30,
    language: 'English · Twi',
  },
  {
    id: 'ren',
    name: 'Ren',
    location: 'Japan',
    region: 'East Asia',
    timeZone: 'Asia/Tokyo',
    mood: 'A little company',
    topic: 'Songs you still know every word to.',
    duration: 15,
    language: 'English · Japanese',
  },
  {
    id: 'santi',
    name: 'Santi',
    location: 'Argentina',
    region: 'South America',
    timeZone: 'America/Argentina/Buenos_Aires',
    mood: 'Trade stories',
    topic: 'The strangest job you have ever had.',
    duration: 20,
    language: 'English · Spanish',
  },
  {
    id: 'mira',
    name: 'Mira',
    location: 'New Zealand',
    region: 'Oceania',
    timeZone: 'Pacific/Auckland',
    mood: 'A thoughtful question',
    topic: 'What are you quietly looking forward to?',
    duration: 30,
    language: 'English',
  },
]

export const signals: Signal[] = signalSeeds.map((signal) => ({
  ...signal,
  color: STATIONS[signal.location].color,
}))

export const formatLocalTime = (timeZone: string) =>
  new Intl.DateTimeFormat('en', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date())
