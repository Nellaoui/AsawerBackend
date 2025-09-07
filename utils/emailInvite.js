const nodemailer = require('nodemailer');

// Create transporter (you'll need to configure your email service)
const transporter = nodemailer.createTransport({
  service: 'gmail', // or your email service
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendInviteEmail = async (email, name, adminName) => {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'You\'ve been invited to our Product Portfolio App',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Welcome to our Product Portfolio!</h2>
          <p>Hello ${name},</p>
          <p>You've been invited by ${adminName} to join our exclusive product portfolio app.</p>
          <p>This app allows you to view and explore products that have been specifically curated for you.</p>
          <p>To get started:</p>
          <ol>
            <li>Download our mobile app</li>
            <li>Register with your email: ${email}</li>
            <li>Start exploring your personalized product collection</li>
          </ol>
          <p>If you have any questions, please don't hesitate to contact us.</p>
          <p>Best regards,<br>The Product Portfolio Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`Invite email sent to ${email}`);
  } catch (error) {
    console.error('Error sending invite email:', error);
    throw error;
  }
};

module.exports = sendInviteEmail;
