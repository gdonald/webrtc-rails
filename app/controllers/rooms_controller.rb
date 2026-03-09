class RoomsController < ApplicationController
  def index
    # Lobby — user picks a room name to join
  end

  def show
    @room = params[:id]
    # Generate a random ID for this browser session.
    # This is passed to the WebRTC Stimulus controller and used as the
    # "from" field in all signaling messages so peers can identify each other.
    @user_id = SecureRandom.uuid
  end
end
