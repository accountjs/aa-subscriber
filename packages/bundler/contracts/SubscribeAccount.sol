// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.12;

/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */
/* solhint-disable reason-string */

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import "@account-abstraction/contracts/core/BaseAccount.sol";
import "@account-abstraction/contracts/samples/callback/TokenCallbackHandler.sol";


struct Subscription {
    address beneficiary;
    address token;
    uint256 amount;
    
    uint256 startTime;
    uint256 endTime;
    uint256 lastTime;
    uint256 interval;
}

/**
  * minimal account.
  *  this is sample minimal account.
  *  has execute, eth handling methods
  *  has a single signer that can send requests through the entryPoint.
  */
contract SubscribeAccount is BaseAccount, TokenCallbackHandler, UUPSUpgradeable, Initializable {
    using ECDSA for bytes32;

    address public serviceProvider;
    address public owner;

    IEntryPoint private immutable _entryPoint;


    uint64 public subscriptionCounter;
    mapping(uint64 => Subscription) private subscriptions; // beneficiary => Subscription

    event SubscribeAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner);
    event SubscriptionSet(uint64 subscriptionId, address indexed beneficiary, address indexed token, uint256 amount, uint256 interval);
    event SubscriptionDeleted(uint64 subscriptionId);
    event SubscriptionPaid(uint64 subscriptionId, address indexed beneficiary, address indexed token, uint256 amount);

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }


    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}

    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
        _disableInitializers();
    }

    function _onlyOwner() internal view {
        //directly from EOA owner, or through the account itself (which gets redirected through execute())
        require(msg.sender == owner || msg.sender == address(this), "only owner");
    }


    function setSubscription(address beneficiary, address token, uint256 amount, uint256 interval, uint256 startTime, uint256 endTime) external returns (uint64){
        _requireFromEntryPointOrOwner();
        subscriptionCounter++;
        subscriptions[subscriptionCounter] = Subscription(beneficiary, token, amount, interval, startTime, endTime, 0);
        emit SubscriptionSet(subscriptionCounter, beneficiary, token, amount, interval);
        return subscriptionCounter;
    }

    function delSubscription(uint64 subscriptionId) external {
        _requireFromEntryPointOrOwner();
        delete subscriptions[subscriptionId];
        emit SubscriptionDeleted(subscriptionId);
    }

    function paySubscription(uint64 subscriptionId) external {
        _requireFromEntryPointOrOwner();
        Subscription storage subscription = subscriptions[subscriptionId];
        if (subscription.beneficiary == address(0)) {
            require(address(this).balance >= subscription.amount, "not enough balance");
            subscription.beneficiary.call{value : subscription.amount}("");
        } else {
            ERC20 token = ERC20(subscription.token);
            require(token.balanceOf(address(this)) >= subscription.amount, "not enough balance");
            token.transfer(subscription.beneficiary, subscription.amount);
        }
        
        require(subscription.lastTime <= subscription.endTime, "expired");
        if (subscription.lastTime < subscription.startTime) {
            subscription.lastTime = subscription.startTime;
        } else {
            subscription.lastTime += subscription.interval;
        }
        emit SubscriptionPaid(subscriptionId, subscription.beneficiary, subscription.token, subscription.amount);
    }

    function hasSubscription(uint64 subscriptionId) external view returns (bool) {
        if (block.timestamp < subscriptions[subscriptionId].startTime || 
        block.timestamp > subscriptions[subscriptionId].lastTime) {
            return false;
        }
        return true;
    }

    /**
     * execute a transaction (called directly from owner, or by entryPoint)
     */
    function execute(address dest, uint256 value, bytes calldata func) external {
        _requireFromEntryPointOrOwner();
        _call(dest, value, func); 
    }

    /**
     * execute a sequence of transactions
     */
    function executeBatch(address[] calldata dest, bytes[] calldata func) external {
        _requireFromEntryPointOrOwner();
        require(dest.length == func.length, "wrong array lengths");
        for (uint256 i = 0; i < dest.length; i++) {
            _call(dest[i], 0, func[i]);
        }
    }

    /**
     * @dev The _entryPoint member is immutable, to reduce gas consumption.  To upgrade EntryPoint,
     * a new implementation of SimpleAccount must be deployed with the new EntryPoint address, then upgrading
      * the implementation by calling `upgradeTo()`
     */
    function initialize(address anOwner, address serv) public virtual initializer {
        _initialize(anOwner, serv);
    }

    function _initialize(address anOwner, address serv) internal virtual {
        owner = anOwner;
        serviceProvider = serv;
        emit SubscribeAccountInitialized(_entryPoint, owner);
    }

    // Require the function call went through EntryPoint or owner
    function _requireFromEntryPointOrOwner() internal view {
        require(msg.sender == address(entryPoint()) || msg.sender == owner || msg.sender == serviceProvider, "account: not Owner or EntryPoint");
    }

    /// implement template method of BaseAccount
    function _validateSignature(UserOperation calldata userOp, bytes32 userOpHash)
    internal override virtual returns (uint256 validationData) {
        bytes32 hash = userOpHash.toEthSignedMessageHash();
        if (owner != hash.recover(userOp.signature) || serviceProvider  != hash.recover(userOp.signature))
            return SIG_VALIDATION_FAILED;
        return 0;
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory result) = target.call{value : value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /**
     * check current account deposit in the entryPoint
     */
    function getDeposit() public view returns (uint256) {
        return entryPoint().balanceOf(address(this));
    }

    /**
     * deposit more funds for this account in the entryPoint
     */
    function addDeposit() public payable {
        entryPoint().depositTo{value : msg.value}(address(this));
    }

    /**
     * withdraw value from the account's deposit
     * @param withdrawAddress target to send to
     * @param amount to withdraw
     */
    function withdrawDepositTo(address payable withdrawAddress, uint256 amount) public onlyOwner {
        entryPoint().withdrawTo(withdrawAddress, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        (newImplementation);
        _onlyOwner();
    }
}

