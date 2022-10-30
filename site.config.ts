import { siteConfig } from './lib/site-config'

export default siteConfig({
  // the site's root Notion page (required)
  rootNotionPageId: 'd997b20454e24c9685624e4eb254935b',

  // if you want to restrict pages to a single notion workspace (optional)
  // (this should be a Notion ID; see the docs for how to extract this)
  rootNotionSpaceId: null,

  // basic site info (required)
  name: 'Roman Boklanov',
  domain: 'boklanov.ru',
  author: 'Roman Boklanov',

  // open graph metadata (optional)
  description: 'Портфолио режиссерских и актёрских работ Романа Бокланова, личный сайт',
  
  // social usernames (optional)
  // instagram: 'boklanovroman',
  // facebook: '100001713857792',
  // linkedin: 'fisch2',
  // newsletter: '#', // optional newsletter URL
  // youtube: '#', // optional youtube channel name or `channel/UCGbXXXXXXXXXXXXXXXXXXXXXX`

  // default notion icon and cover images for site-wide consistency (optional)
  // page-specific values will override these site-wide defaults
  defaultPageIcon: null,
  defaultPageCover: null,
  defaultPageCoverPosition: 0.5,

  // whether or not to enable support for LQIP preview images (optional)
  isPreviewImageSupportEnabled: true,

  // whether or not redis is enabled for caching generated preview images (optional)
  // NOTE: if you enable redis, you need to set the `REDIS_HOST` and `REDIS_PASSWORD`
  // environment variables. see the readme for more info
  isRedisEnabled: true,

  // map of notion page IDs to URL paths (optional)
  // any pages defined here will override their default URL paths
  // example:
  //
   pageUrlOverrides: {
       '/Bury-Me-Behind-the-Baseboard': 'ee2d7bea11484e16bcb03effc276a719',
       '/Bury-Me-Behind-the-Baseboard-en': 'Bury-Me-Behind-the-Baseboard-c6f2c93cbb534a19ba38b81226aa795b',
       '/The-Ape-Star': 'b5811360180c43efac06a8b18fe89100'
       '/The-Ape-Star-en': 'The-Ape-Star-91807219acdd460391f245c5791a8323'
       
  //   '/The-Ape-Star': 'b5811360180c43efac06a8b18fe89100'
   }
  // pageUrlOverrides: null,

  // whether to use the default notion navigation style or a custom one with links to
  // important pages
  navigationStyle: 'default'
  // navigationStyle: 'custom',
  // navigationLinks: [
  //   {
  //     title: 'About',
  //     pageId: 'f1199d37579b41cbabfc0b5174f4256a'
  //   },
  //   {
  //     title: 'Contact',
  //     pageId: '6a29ebcb935a4f0689fe661ab5f3b8d1'
  //   }
  // ]
})
