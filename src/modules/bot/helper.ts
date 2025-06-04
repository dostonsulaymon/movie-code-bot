// import { Bot, Context } from 'grammy';
// import { Injectable } from '@nestjs/common';

// export class AppService {
//   private bot: Bot<Context>;

//   constructor() {
//     this.bot = new Bot('REDACTED');

//     this.bot.on('message', async (ctx) => {
//       console.log('Received a message from:', ctx.chat.id);
//       const msg = ctx.message;
//       const chat = ctx.chat;
//       const forwardedFromChannelId = (msg as any).forward_from_chat?.id;


//       console.log('Chat type:', chat.type);
//       console.log('Chat title:', chat.title  'N/A');
//       console.log('Chat username:', chat.username  'N/A');

//       const targetChannelId = -1002560626233;

//       if (forwardedFromChannelId === targetChannelId) {
//         console.log('New message in target channel:');
//         console.log('Message ID:', msg.message_id);
//         console.log('Caption:', msg.caption);

//         // Additional channel info
//         if (msg.sender_chat) {
//           console.log('Sender chat type:', msg.sender_chat.type);
//           console.log('Sender chat ID:', msg.sender_chat.id);
//         }

//         // Forward info if available
//         if ((msg as any).forward_from_chat) {
//           console.log(
//             'Original channel ID:',
//             (msg as any).forward_from_chat.id,
//           );
//           console.log(
//             'Original channel type:',
//             (msg as any).forward_from_chat.type,
//           );

//           console.log(
//             Original channel message ID:,
//             (msg as any).forward_from_message_id,
//           );
//         }

//         if (msg.video) {
//           console.log('Video File ID:', msg.video.file_id);
//         } else if (msg.document) {
//           console.log('Document File ID:', msg.document.file_id);
//         } else {
//           console.log('No video or document found in message.');
//         }
//       }
//     });

//     this.bot.start();
//   }
// }