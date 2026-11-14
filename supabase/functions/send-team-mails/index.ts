// Fonction Supabase « send-team-mails » : envoie les e-mails du Classé foot depuis la boîte Gmail du site.
//   { type: "registered", team_id }          → « Équipe bien inscrite » à tous les joueurs de l'équipe (capitaine uniquement)
//   { type: "challenge", from_team, to_team } → proposition de match au capitaine de l'équipe adverse
// Secrets à créer dans Supabase › Edge Functions › Secrets : SMTP_USER (adresse Gmail du site) et SMTP_PASS (mot de passe d'application).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SITE = "https://upjvsport.github.io/upjv-sport/";
const LOGO = "https://raw.githubusercontent.com/upjvsport/upjv-sport/main/emails/logo-upjv-sport.png";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function layout(title: string, paragraphs: string[], button?: { label: string; href: string }) {
  const p = paragraphs.map((t) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#dfe7f5;">${t}</p>`).join("");
  const btn = button ? `<tr><td align="left" style="padding:6px 30px 30px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#e10600;border-radius:28px;"><a href="${button.href}" style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:28px;">${esc(button.label)}</a></td></tr></table></td></tr>` : "";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#0b1730;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b1730;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#082d5b;border-left:6px solid #e10600;">
<tr><td style="background:#05101f;padding:22px 30px;border-bottom:3px solid #e10600;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:14px;"><img src="${LOGO}" width="48" height="56" alt="UPJV SPORT" style="display:block;border:0;"></td>
<td style="font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:22px;font-weight:900;letter-spacing:2px;color:#ffffff;">UPJV <span style="color:#e10600;">SPORT</span></td></tr></table></td></tr>
<tr><td style="padding:34px 30px 8px;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#e10600;">Classé · Foot à 5</p>
<h1 style="margin:0 0 18px;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:26px;line-height:1.15;font-weight:900;text-transform:uppercase;color:#ffffff;">${esc(title)}</h1>${p}</td></tr>${btn}
<tr><td style="background:#05101f;padding:18px 30px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#aeb9d0;">UPJV SPORT · Projet étudiant · IUT d'Amiens<br>Tu reçois cet e-mail parce que ton compte est lié à une équipe du classé.</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(token);
    const me = who?.user; if (!me) return json({ error: "Connecte-toi pour continuer." }, 401);
    const body = await req.json();
    const mail = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASS")! } } });
    const send = (to: string, subject: string, html: string, text: string) =>
      mail.send({ from: `UPJV SPORT <${Deno.env.get("SMTP_USER")}>`, to, subject, content: text, html });
    const person = async (id: string) => { const { data } = await admin.auth.admin.getUserById(id); const u = data.user!; const m = u.user_metadata || {}; return { email: u.email!, prenom: m.prenom || "", nom: m.nom || "", snapchat: m.snapchat || "", instagram: m.instagram || "" }; };

    if (body.type === "registered") {
      const { data: team } = await admin.from("teams").select("id,name,captain_id,welcome_sent").eq("id", body.team_id).single();
      if (!team || team.captain_id !== me.id) return json({ error: "Action non autorisée." }, 403);
      if (team.welcome_sent) return json({ ok: true, already: true });
      const { data: members } = await admin.from("team_members").select("user_id").eq("team_id", team.id);
      const people = await Promise.all((members || []).map((m) => person(m.user_id)));
      const cap = people.find((_, i) => members![i].user_id === team.captain_id)!;
      const roster = people.map((p) => `${esc(p.prenom)} ${esc(p.nom.toUpperCase())}`).join(", ");
      for (const p of people) {
        const html = layout("Équipe bien inscrite", [
          `Salut ${esc(p.prenom) || ""}, l'équipe <b style="color:#ffffff;">${esc(team.name)}</b> est bien inscrite au classé de foot à 5 de UPJV SPORT.`,
          `Capitaine : ${esc(cap.prenom)} ${esc(cap.nom.toUpperCase())}.<br>Joueurs : ${roster}.`,
          `Ton équipe apparaît « en attente » dans le classement. Dès qu'elle est validée par l'équipe UPJV SPORT, tu pourras proposer des matchs aux autres équipes depuis le site.`,
        ], { label: "Voir le classé", href: SITE + "#classe-foot" });
        await send(p.email, `Équipe bien inscrite · ${team.name}`, html, `L'équipe ${team.name} est bien inscrite au classé de foot à 5 de UPJV SPORT. Joueurs : ${people.map((x) => x.prenom + " " + x.nom).join(", ")}. ${SITE}#classe-foot`);
      }
      await admin.from("teams").update({ welcome_sent: true }).eq("id", team.id);
      await mail.close();
      return json({ ok: true, sent: people.length });
    }

    if (body.type === "challenge") {
      const { data: from } = await admin.from("teams").select("id,name,captain_id,status").eq("id", body.from_team).single();
      const { data: to } = await admin.from("teams").select("id,name,captain_id,status").eq("id", body.to_team).single();
      if (!from || !to || from.captain_id !== me.id) return json({ error: "Action non autorisée." }, 403);
      if (from.id === to.id) return json({ error: "Tu ne peux pas défier ta propre équipe." }, 400);
      if (from.status !== "validated" || to.status !== "validated") return json({ error: "Les deux équipes doivent être validées." }, 400);
      const ins = await admin.from("match_requests").insert({ from_team: from.id, to_team: to.id, created_by: me.id });
      if (ins.error) return json({ error: ins.error.code === "23505" ? "Tu as déjà proposé un match à cette équipe." : "Envoi impossible pour le moment." }, 409);
      const cap = await person(from.captain_id), rival = await person(to.captain_id);
      const contact = [cap.snapchat && `Snapchat : ${esc(cap.snapchat)}`, cap.instagram && `Instagram : @${esc(cap.instagram)}`].filter(Boolean).join("<br>");
      const html = layout("Un match vous est proposé", [
        `Salut ${esc(rival.prenom) || ""}, l'équipe <b style="color:#ffffff;">${esc(from.name)}</b> propose un match à ton équipe <b style="color:#ffffff;">${esc(to.name)}</b> dans le classé de foot à 5.`,
        `Son capitaine, ${esc(cap.prenom)} ${esc(cap.nom.toUpperCase())}, t'a laissé ses coordonnées pour vous organiser :<br><b style="color:#ffffff;">${contact || "contacte-le via le site"}</b>`,
        `Mettez-vous d'accord sur la date et le lieu, puis jouez : le résultat sera ajouté au classement par l'équipe UPJV SPORT.`,
      ], { label: "Voir le classé", href: SITE + "#classe-foot" });
      await send(rival.email, `Match proposé : ${from.name} contre ${to.name}`, html, `${from.name} propose un match à ${to.name}. Contact du capitaine : ${cap.snapchat ? "Snapchat " + cap.snapchat : ""} ${cap.instagram ? "Instagram @" + cap.instagram : ""}. ${SITE}#classe-foot`);
      await mail.close();
      return json({ ok: true });
    }
    return json({ error: "Requête inconnue." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Envoi impossible pour le moment." }, 500);
  }
});
