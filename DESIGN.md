# Campaign Management System
Digital marketing campaign management platform.

## Overview

A professional, efficient design system for digital marketing campaign management. Uses bold red and deep navy to convey energy and trust. The clean, structured aesthetic supports fast decision-making and clear data visualization for marketing teams.

## Colors

- **Primary** (#ED1C24): Red -- CTAs, main actions, key indicators
- **Secondary** (#1D1C74): Navy -- links, headers, informational highlights
- **Tertiary** (#A8A29E): Warm Gray -- muted accents, inactive states
- **Neutral** (#78716C): Stone -- secondary text, subtle UI elements
- **Background** (#FAFAFF): App background, root canvas
- **Surface** (#FFFFFF): Cards, panels, modals
- **Success** (#10B981): Goals met, on-track budgets
- **Warning** (#F59E0B): Approaching limit, review needed
- **Error** (#ED1C24): Over budget, failed transactions (uses Primary Red)
- **Info** (#1D1C74): Tips, suggestions, helpful callouts (uses Secondary Navy)

## Typography

- **Headline Font**: Vazirmatn
- **Body Font**: Vazirmatn
- **Mono Font**: Vazirmatn

- **Display**: Vazirmatn 36px extra-bold, 1.15 line height, 0.02em tracking
- **Headline**: Vazirmatn 28px bold, 1.2 line height, 0.01em tracking
- **Subhead**: Vazirmatn 20px semibold, 1.3 line height
- **Body Large**: Vazirmatn 18px regular, 1.6 line height
- **Body**: Vazirmatn 16px regular, 1.6 line height
- **Body Small**: Vazirmatn 14px regular, 1.5 line height, 0.01em tracking
- **Caption**: Vazirmatn 12px semibold, 1.4 line height, 0.02em tracking
- **Overline**: Vazirmatn 11px bold, 1.2 line height, 0.06em tracking
- **Code**: Vazirmatn 14px regular, 1.6 line height

## Spacing

- **Base unit:** 8px
- **Scale:** 8 / 16 / 24 / 32 / 40 / 48 / 64 / 80 / 96
- **Component padding:** 16px horizontal, 12px vertical
- **Section spacing:** 40px between major sections, 24px between related groups

## Border Radius

- **None** (0px): Dividers, progress bar tracks
- **Small** (6px): Chips, inline badges
- **Medium** (12px): Buttons, inputs, cards
- **Large** (16px): Modals, panels, feature cards
- **XL** (24px): Hero sections, goal cards
- **Full** (9999px): Avatars, toggles, progress endpoints

## Elevation

**Philosophy:** Subtle, peaceful shadows that float elements gently above the surface. Never harsh or dramatic -- the aesthetic should feel like a calm morning.
- **Subtle**: 1px offset, 3px blur, #1C1917 at 6%
- **Medium**: 4px offset, 12px blur, #1C1917 at 8%
- **Large**: 8px offset, 24px blur, #1C1917 at 10%
- **Overlay**: 16px offset, 48px blur, #1C1917 at 14%

## Components

### Buttons
#### Variants
- **Primary**: #ED1C24 fill, #FFFFFF text, no border. Hover: #c41820.
- **Secondary**: transparent fill, #1D1C74 text, 1.5px #1D1C74 border. Hover: bg #1D1C741A, border darker.
- **Ghost**: transparent fill, #57534E text, no border. Hover: bg #F5F5F4, text #1C1917.
- **Destructive**: #ED1C24 fill, #FFFFFF text, no border. Hover: #c41820.
#### Sizes
Sizes: Small (32px, 8px 16px, 13px, 12px), Medium (40px, 10px 20px, 15px, 12px), Large (48px, 12px 28px, 17px, 12px).
#### Disabled State
0.5 opacity.
- disabled cursor
- Background desaturated

### Cards
- **Background**: #FFFFFF default, #FFFFFF elevated.
- **Border**: 1px #E7E5E4 default.
- **Radius**: 12px default, 16px elevated.
- **Padding**: 20px default, 24px elevated.
- **Shadow**: 1px offset, 3px blur, #1C1917 at 6% default, 0 4px 12px #1C1917 at 8% elevated.
- **Hover**: shadow upgrades to Medium default, shadow upgrades to Large elevated.

### Inputs
#### Text Input
- **Default**: 1.5px #D6D3D1 border, #FFFFFF fill, #1C1917 text, no shadow.
- **Hover**: 1.5px #A8A29E border, #FFFFFF fill, #1C1917 text, no shadow.
- **Focus**: 1.5px #ED1C24 border, #FFFFFF fill, #1C1917 text, 3px ring #ED1C24 at 15% shadow.
- **Error**: 1.5px #ED1C24 border, #FFFFFF fill, #1C1917 text, 3px ring #ED1C24 at 12% shadow.
- **Disabled**: 1.5px #E7E5E4 border, #F5F5F4 fill, #A8A29E text, no shadow.
** 44px **height, ** 12px 16px **padding, ** 12px **radius, ** 14px / 600 / #57534E, 6px below **label, ** 13px / 400 / #78716C, 4px above **helper text.

### Chips
#### Filter Chip
** #F5F5F4 **background, ** #57534E / 13px / 600 **text, ** 1px #E7E5E4 **border, ** 6px **radius, ** 6px 12px **padding, ** bg #ED1C241A, border #ED1C24, text #ED1C24 **active.
#### Status Chip
** bg #10B9811A, text #059669, border #10B98133 **on track, ** bg #F59E0B1A, text #D97706, border #F59E0B33 **at risk, ** bg #ED1C241A, text #ED1C24, border #ED1C2433 **over budget.

### Lists
#### Default Item
** 52px **height, ** 12px 16px **padding, ** 1px #E7E5E4 **divider, ** bg #F5F5F4 **hover, ** bg #ED1C240D, left 3px #ED1C24 **selected, ** 16px / 400 / #1C1917 **font.

### Checkboxes
** 20px **size, ** 1.5px #D6D3D1 **border, ** 6px **radius, ** bg #ED1C24, border #ED1C24, white checkmark **checked, ** bg #ED1C24, white dash **indeterminate, ** 50% opacity, disabled cursor **disabled, ** 16px / 400 / #1C1917, 10px gap **label.

### Radio Buttons
** 20px **size, ** 1.5px #D6D3D1 **border, ** border #ED1C24, inner dot #ED1C24 (10px) **selected, ** 50% opacity, disabled cursor **disabled, ** 16px / 400 / #1C1917, 10px gap **label.

### Tooltips
** #1C1917 **background, ** #FAFAFA / 13px / 400 **text, ** 8px 12px **padding, ** 8px **radius, ** 260px **max width, ** 6px, same background **arrow, ** 400ms show, 100ms hide **delay.

## Do's and Don'ts

1. **Do** use progress bars and visual milestones to celebrate savings goals and budget targets.
2. **Do** use encouraging, supportive language -- "Great progress!" instead of "You spent too much."
3. **Don't** use guilt-inducing patterns like red-heavy dashboards or alarming iconography for minor overspending.
4. **Do** highlight goal milestones (25%, 50%, 75%, 100%) with subtle animations or confetti moments.
5. **Don't** overwhelm users with too many numbers at once; progressive disclosure keeps it calm.
6. **Do** use soft, rounded shapes and generous whitespace to maintain a stress-free atmosphere.
7. **Do** provide positive framing: "You have $200 left this month" over "You spent $800."
8. **Don't** auto-expand expense categories; let users drill in at their own pace.
9. **Do** use the Sky secondary color for tips and educational content to differentiate from action items.
10. **Don't** hide essential information behind multiple taps; budgets and balances should be one glance away.