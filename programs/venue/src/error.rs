use pinocchio::error::ProgramError;

/// Custom error codes (ProgramError::Custom). Numbered from 6000 so they never collide with
/// the token programs' own codes that surface through CPI.
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum E {
    NotAdmitted = 6000,
    TradingHalted = 6001,
    HaltDataStale = 6002,
    NotActive = 6003,
    Paused = 6004,
    CapReached = 6005,
    SlippageExceeded = 6006,
    SymbolCapReached = 6007,
    NoticeWindowOpen = 6008,
    Objected = 6009,
    Unauthorized = 6010,
    InvalidAccount = 6011,
    InsufficientShares = 6012,
    StaleSequence = 6013,
    InvalidAmount = 6014,
    AlreadyInitialized = 6015,
    InvalidArgument = 6016,
}

impl From<E> for ProgramError {
    #[inline(always)]
    fn from(e: E) -> Self {
        ProgramError::Custom(e as u32)
    }
}
