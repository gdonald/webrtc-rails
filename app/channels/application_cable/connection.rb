module ApplicationCable
  # Every WebSocket connection lands here first.
  # Because this demo has no authentication, we generate a random UUID
  # so the server can still identify individual connections.
  class Connection < ActionCable::Connection::Base
    identified_by :current_user_id

    def connect
      self.current_user_id = SecureRandom.uuid
    end
  end
end
