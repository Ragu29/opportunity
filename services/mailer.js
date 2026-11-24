const nodemailer = require("nodemailer");

// same SMTP settings as the product services
let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_Mail_Host,
      port: process.env.SMTP_Mail_port,
      secure: false,
      auth: { user: process.env.SMTP_TO_EMAIL, pass: process.env.SMTP_TO_PASSWORD },
      tls: { ciphers: "SSLv3" },
    });
  }
  return transporter;
};

// -> { success, messageId } | { success: false, error }; never throws
const sendMail = async ({ to, subject, html }) => {
  try {
    const info = await getTransporter().sendMail({ from: process.env.SMTP_TO_EMAIL, to, subject, html });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = { sendMail };
