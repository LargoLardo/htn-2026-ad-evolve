import { redirect } from 'next/navigation';

/** The experiments list is now /dashboard itself. Keep the old path working. */
export default function RunsIndex() {
  redirect('/dashboard');
}
