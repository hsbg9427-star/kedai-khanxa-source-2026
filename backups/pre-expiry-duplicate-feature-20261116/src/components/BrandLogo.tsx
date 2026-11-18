import React from 'react';

interface BrandLogoProps {
  size?: 'sm' | 'md';
}

export function BrandLogo({ size = 'sm' }: BrandLogoProps) {
  const dim = size === 'md' ? 'w-10 h-10' : 'w-9 h-9';
  return (
    <div
      className={`${dim} rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 36 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-6 h-6"
      >
        <path
          d="M6 12.5L9.5 7H26.5L30 12.5C30 14.433 28.433 16 26.5 16C24.567 16 23 14.433 23 12.5C23 14.433 21.433 16 19.5 16C17.567 16 16 14.433 16 12.5C16 14.433 14.433 16 12.5 16C10.567 16 9 14.433 9 12.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9 16V28C9 28.5523 9.44772 29 10 29H26C26.5523 29 27 28.5523 27 28V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M14 20V25M14 22.5L17.5 20M15.5 21.5L18 25M20 20V25M20 22.5L23.5 20M21.5 21.5L24 25"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
