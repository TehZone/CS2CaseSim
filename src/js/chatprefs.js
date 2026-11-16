// The chat switches (Settings: Chat), each on unless turned off: the match's text chat (other players' and the bots'
// messages in a match, and typing yours) and the friends chat (the Friends page's messages, their pop-ups and counts).
// Kept with the save's other settings, on this PC. Changing one sends 'chatPrefs' on the state bus, with which one
// ('chat' there is a message coming in).
import { S, save, emit } from './state.js';

export const matchChatOn = () => S.settings.matchChat !== false;
export const friendsChatOn = () => S.settings.friendsChat !== false;

export function setChat(which, on) {
  S.settings[which] = !!on;
  save();
  emit('chatPrefs', which);
}
